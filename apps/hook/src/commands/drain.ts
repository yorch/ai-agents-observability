import { flushOnce } from '../flusher';
import { backoffMs } from '../lib/backoff';
import { loadHookToken } from '../lib/identity';
import { getIngestBaseUrl } from '../lib/ingest';
import {
  clearRejectedToken,
  clearSpawnClaim,
  clearSpawnHold,
  holdSpawns,
  isLeaseHeld,
  isTokenRejected,
  readFailureStreak,
  recordDrainOk,
  recordRejectedToken,
  withLease,
  writeFailureStreak,
} from '../lib/lease';
import { log } from '../lib/log';
import { queuePath } from '../lib/paths';
import { openQueueReader } from '../lib/queue-reader';
import {
  clearMarkerDeferrals,
  countDeferredMarkers,
  hasShippableMarkers,
  pendingMarkerCount,
  shipPass,
} from '../shipper';

/** Hard wall-clock cap on one drain pass; a drainer is never a daemon. */
export const DRAIN_CAP_MS = 120_000;

/** Bounds on "look again before letting go", so a pass cannot spin on work it cannot finish. */
const MAX_ROUNDS_PER_LEASE = 10;
const MAX_LEASE_ACQUISITIONS = 3;

export type DrainReport = {
  /** Events POSTed this pass. */
  flushed: number;
  /** Queue rows still owed, including ones held back by a retry time. */
  remainingEvents: number;
  /** Transcripts still owed. */
  remainingTranscripts: number;
  /** Why the pass ended. `busy` means another delivery process held the lease. */
  stop: 'done' | 'no_token' | 'unauthorized' | 'transport' | 'cap' | 'lease_lost' | 'busy';
};

/**
 * One delivery pass — events first, THEN transcripts (the transcript route 404s
 * until the session row exists) — that ends on: nothing left due, the first
 * transport failure, no token, a 401, or the wall-clock cap. It never sleeps
 * waiting for anything: whatever it could not deliver stays on disk with its retry
 * time, and the next drainer (or the resident daemon) carries on.
 *
 * "Nothing left due" is checked AGAIN before the lease is let go, and once more
 * after. A terminal hook that fires while a drainer is running sees a held lease
 * and spawns nothing, so without the re-check a final Stop or SessionEnd landing
 * mid-pass would sit undelivered until the next session. The window between the
 * last check and the release is closed by checking after the release too: by then
 * a hook arriving later finds the lease free and spawns its own drainer.
 *
 * The two re-checks (inside the lease, after it) deliberately OVERLAP: either one
 * alone covers a hook that lands mid-pass, and the gap the second one closes is
 * microseconds wide, so no test can tell them apart. Keep both; removing one is
 * safe only until the other is "simplified" away too.
 *
 * A drainer needs the `events` lease and merely WANTS `transcripts`. If a resident
 * shipper or an `aiot import` holds the latter, it delivers the events and leaves
 * the transcripts to that holder.
 *
 * `wait` is the foreground variant (`aiot drain --wait`): it also waits, up to
 * the cap, for a drainer that is already running, and ships every transcript
 * regardless of the on-demand cadence.
 */
export async function drainPass(
  opts: { capMs?: number; wait?: boolean } = {},
): Promise<DrainReport> {
  const capMs = opts.capMs ?? DRAIN_CAP_MS;
  const deadline = Date.now() + capMs;
  const cap = new AbortController();
  const capTimer = setTimeout(() => cap.abort(), capMs);
  const reader = openQueueReader(queuePath());
  const report: DrainReport = {
    flushed: 0,
    remainingEvents: 0,
    remainingTranscripts: 0,
    stop: 'busy',
  };
  // Whether the lease we last held covered transcripts: only then is a shippable
  // marker work THIS process can do (otherwise it would loop on work it may not touch).
  let coversTranscripts = false;
  // A shippable marker is this process's work if it holds the transcripts lease, or if
  // nobody does (an import that finished while we were delivering events): then the
  // next acquisition takes both. If someone else holds it, it is theirs, and looping
  // on it would spin.
  const moreWork = (): boolean =>
    reader.hasDue() ||
    ((coversTranscripts || !isLeaseHeld(reader.db, 'transcripts')) && hasShippableMarkers());
  // Did this process ever take a lease? If not it must hand back the spawn claim the
  // hook set for it, or every hook inside the 10 s window is stranded.
  let tookLease = false;

  try {
    const ingestBaseUrl = getIngestBaseUrl();
    const token = loadHookToken();
    // A token ingest rejected within the re-probe interval is not tried again, and
    // nothing is pruned for it: the resident daemons make the same decision from
    // memory, but a drainer has none, so it is read from queue.db.
    const tokenRejected = token !== null && isTokenRejected(reader.db, token);
    // How many passes in a row ended in a transport failure, from queue.db: the
    // growth in retry backoff has to survive the process, which a drainer is. Read
    // once the lease is ours (a `--wait` drainer may have queued behind another
    // pass that changed it), so a stale value is never written back.
    let streak = 0;

    const passBody = async (lease: {
      check(): boolean;
      kinds: readonly string[];
      signal: AbortSignal;
      tryAdd(kind: 'transcripts'): boolean;
    }): Promise<DrainReport['stop']> => {
      // The lease is ours: from here it, not the spawn claim, keeps other hooks
      // from spawning.
      tookLease = true;
      coversTranscripts = lease.kinds.includes('transcripts');
      streak = readFailureStreak(reader.db);
      clearSpawnClaim(reader.db);
      const signal = AbortSignal.any([cap.signal, lease.signal]);
      const stopNow = (): 'cap' | 'lease_lost' | null => {
        if (Date.now() >= deadline || cap.signal.aborted) {
          return 'cap';
        }
        return lease.check() ? null : 'lease_lost';
      };

      // Age expiry, once per pass and only with a usable token: while logged out
      // (or rejected) nothing can be delivered, and the 7-day clock must not turn
      // that into loss.
      if (token !== null) {
        const expired = reader.dropExpired();
        if (expired > 0) {
          log('warn', 'flusher.dropped_expired', { count: expired });
        }
      }

      for (let round = 0; round < MAX_ROUNDS_PER_LEASE; round++) {
        for (;;) {
          const early = stopNow();
          if (early) {
            return early;
          }
          const r = await flushOnce(reader, ingestBaseUrl, streak, {
            persistBackoff: true,
            shouldStop: () => stopNow() !== null,
            signal,
          });
          if (r.outcome === 'empty') {
            break;
          }
          if (r.outcome === 'sent') {
            report.flushed += r.count;
            if (r.count > 0) {
              clearRejectedToken(reader.db);
              // The server answered: transcripts held back while it did not are due.
              clearMarkerDeferrals();
            }
            continue;
          }
          if (r.outcome === 'unauthorized') {
            recordRejectedToken(reader.db, r.token);
            return 'unauthorized';
          }
          // No token is for the user; anything else is the server or the network.
          // Either way this pass has nothing more it can do.
          if (r.outcome === 'aborted') {
            return stopNow() ?? 'transport';
          }
          return r.outcome === 'no_token' ? 'no_token' : 'transport';
        }

        // We may have started without the transcripts lease; whoever held it (an import)
        // may be done by now.
        coversTranscripts = coversTranscripts || lease.tryAdd('transcripts');
        if (!coversTranscripts) {
          // Someone else (a shipper, an import) is still on the transcripts. The events
          // are delivered; leave the rest to them (an import drains once it finishes).
          break;
        }
        const ship = await shipPass({
          force: opts.wait ?? false,
          mode: 'drain',
          shouldStop: () => stopNow() !== null,
          signal,
        });
        if (ship.stop === 'unauthorized' && token !== null) {
          recordRejectedToken(reader.db, token);
        }
        if (ship.stop !== 'done') {
          // A pass cut short by a lost lease or the deadline says so, rather than
          // passing for whatever transport error the aborted request surfaced as.
          return stopNow() ?? ship.stop;
        }
        // Something may have landed while we were shipping (a Stop, the SessionEnd).
        if (!moreWork()) {
          break;
        }
      }
      return 'done';
    };

    if (tokenRejected) {
      report.stop = 'unauthorized';
    } else {
      for (let acquisition = 0; acquisition < MAX_LEASE_ACQUISITIONS; acquisition++) {
        const leased = await withLease(reader.db, 'drain', passBody, {
          waitMs: acquisition === 0 && opts.wait ? capMs : 0,
        });
        if (!leased.held) {
          // Busy on the first try is the answer. Busy later means another drainer
          // took over after we let go, and it will do the looking.
          if (acquisition === 0) {
            report.stop = 'busy';
          }
          break;
        }
        report.stop = leased.value;
        if (report.stop !== 'done' || Date.now() >= deadline || !moreWork()) {
          break;
        }
      }
    }

    report.remainingEvents = reader.depth();
    report.remainingTranscripts = pendingMarkerCount();
    // A clean drain means nothing is left that a later pass owes us — not merely
    // that nothing is DUE: rows or markers held back by a retry time still count,
    // or `aiot status` would show "last drain: just now" over a stuck queue. A marker
    // waiting only for the 10-minute transcript cadence is not stuck, but one that is
    // shippable NOW and left alone because another process held the transcripts is
    // owed, and `aiot status` keeps showing it as pending.
    const transcriptsOwed = !coversTranscripts && hasShippableMarkers();
    if (
      report.stop === 'done' &&
      report.remainingEvents === 0 &&
      countDeferredMarkers() === 0 &&
      !transcriptsOwed
    ) {
      recordDrainOk(reader.db);
    }
    if (
      report.stop === 'transport' ||
      report.stop === 'no_token' ||
      report.stop === 'unauthorized'
    ) {
      // A failing environment: the streak lengthens the retry time of the rows that
      // failed, and the HOLD keeps new hooks from spawning a drainer per Stop into
      // the same failure (each Stop adds a new due row that no retry time covers).
      const next = report.stop === 'transport' ? streak + 1 : streak;
      if (report.stop === 'transport') {
        writeFailureStreak(reader.db, next);
      }
      holdSpawns(reader.db, backoffMs(next));
    } else if (report.flushed > 0 || (report.stop === 'done' && report.remainingEvents === 0)) {
      // Something got through (or there was nothing to send): start over. A pass that
      // was merely idle because everything is held back by a retry time proves
      // nothing about the server and must not reset either.
      writeFailureStreak(reader.db, 0);
      clearSpawnHold(reader.db);
    }
    log('info', 'drain.done', { ...report });
    return report;
  } finally {
    clearTimeout(capTimer);
    if (!tookLease) {
      // Busy, rejected token, or dead before acquiring (SQLITE_BUSY): the claim the
      // hook set for us would otherwise block every hook for the rest of its 10 s.
      try {
        clearSpawnClaim(reader.db);
      } catch {
        // Still locked: the claim expires on its own.
      }
    }
    reader.close();
  }
}

const STOP_TEXT: Record<DrainReport['stop'], string> = {
  busy: 'another aiot delivery process holds the lease',
  cap: 'hit the time cap',
  done: 'complete',
  lease_lost: 'lost the delivery lease',
  no_token: 'no auth token — run `aiot login`',
  transport: 'the ingest server was unreachable or failing',
  unauthorized: 'token rejected — run `aiot login`',
};

export async function runDrain(args: string[]): Promise<number> {
  const wait = args.includes('--wait');
  // Last-resort bound for a pass that outlives its own cap — an await that never
  // settles despite the abort signals. Timers cannot fire during a synchronous
  // call, so this does not cover one; the lease TTL frees the lease either way.
  const watchdog = setTimeout(() => {
    log('error', 'drain.watchdog', {});
    process.exit(wait ? 1 : 0);
  }, DRAIN_CAP_MS + 10_000);

  let report: DrainReport;
  try {
    report = await drainPass({ wait });
  } catch (err) {
    log('error', 'drain.failed', { message: (err as Error).message });
    if (wait) {
      process.stderr.write(`drain failed: ${(err as Error).message}\n`);
    }
    return wait ? 1 : 0;
  } finally {
    clearTimeout(watchdog);
  }

  if (!wait) {
    // A background drainer reports nothing: its stdio is /dev/null, and what
    // happened is in hook.log and `aiot status`.
    return 0;
  }
  process.stdout.write(
    [
      `events sent:          ${report.flushed}`,
      `events remaining:     ${report.remainingEvents}`,
      `transcripts remaining: ${report.remainingTranscripts}`,
      `result:               ${STOP_TEXT[report.stop]}`,
      '',
    ].join('\n'),
  );
  const dataRemains = report.remainingEvents > 0 || report.remainingTranscripts > 0;
  return dataRemains || report.stop !== 'done' ? 1 : 0;
}
