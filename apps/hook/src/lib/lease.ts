import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { REJECTED_TOKEN_REPROBE_MS } from './identity';
import { log } from './log';
import { queuePath } from './paths';
import { openQueueReader } from './queue-reader';

/**
 * The delivery leases: at most one process at a time may do each kind of
 * delivery work.
 *
 * Two shippers uploading the same session at once waste work and, with chunked
 * uploads, contend for one server-side scratch file; two flushers would
 * double-send batches. So the resident flusher, the resident shipper, `aiot
 * import` and the on-demand drainer coordinate through these rows.
 *
 * There are TWO leases, not one, so a long, throttled transcript sweep never holds
 * up event delivery: `events` (flusher) and `transcripts` (shipper, import). A
 * drainer does both kinds of work: it NEEDS `events` and takes `transcripts` too
 * when it is free.
 *
 * Each is a row in queue.db with an expiry, not a flock or a PID file. A holder
 * that crashes simply stops renewing and the lease frees itself after the TTL —
 * no FFI, no stale lock file, and no PID-reuse hazard because ownership is a
 * random token, not a pid. The pid is recorded for `aiot status` / uninstall.
 *
 * Expiry is wall-clock, so two guards: a lease that claims to outlive now + TTL
 * can only come from a clock that has since stepped backwards and is treated as
 * expired; and a holder whose clock stepped forward (suspend, NTP) learns it lost
 * the lease at its next renewal — which aborts its in-flight requests — rather
 * than carrying on beside whoever took over.
 */
export const LEASE_TTL_MS = 15_000;
export const LEASE_RENEW_MS = 5_000;
/**
 * A lease claiming to outlive `now` by more than this can only come from a clock
 * that has since stepped backwards. It is several TTLs, not one, because `now` is
 * read BEFORE a contended UPDATE waits for the write lock: a holder that acquired
 * or renewed in the meantime legitimately expires up to TTL + (the wait) after the
 * contender's `now`. A tight bound here let a contender steal a lease that had
 * just been taken — mutual exclusion failed in about one run in ten under load.
 */
const LEASE_SANITY_MS = 3 * LEASE_TTL_MS;

export type LeaseKind = 'events' | 'transcripts';
export type LeaseRole = 'flusher' | 'shipper' | 'import' | 'drain';

/** What a role cannot work without. */
const KINDS_FOR_ROLE: Record<LeaseRole, LeaseKind[]> = {
  drain: ['events'],
  flusher: ['events'],
  import: ['transcripts'],
  shipper: ['transcripts'],
};

/**
 * What a role takes if it can get it. A drainer needs `events` and WANTS
 * `transcripts`: when a resident shipper or an import holds that one, the drainer
 * still delivers the events and leaves the transcripts to the holder, instead of
 * giving up the whole pass (which stranded every hook that fired meanwhile).
 */
const OPTIONAL_KINDS_FOR_ROLE: Partial<Record<LeaseRole, LeaseKind[]>> = {
  drain: ['transcripts'],
};

export type LeaseHolder = {
  expiresAt: number;
  pid: number;
  role: string;
  startedAt: number;
};

export type Lease = {
  /** True once a renewal found the lease taken by someone else. */
  readonly lost: boolean;
  /** The kinds this hold actually covers (a drainer may not get `transcripts`). */
  readonly kinds: readonly LeaseKind[];
  /** Aborted the moment the lease is lost: hand it to every fetch. */
  readonly signal: AbortSignal;
  /** Renew now; false means we no longer own it and must stop shipping. */
  check(): boolean;
  /**
   * Try to ADD a kind to a hold already in progress (a drainer that started without
   * `transcripts` asking again once its events are done: the holder may have finished).
   * True if the kind is held afterwards.
   */
  tryAdd(kind: LeaseKind): boolean;
};

type LeaseRow = {
  expires_at: number;
  pid: number | null;
  role: string | null;
  started_at: number | null;
};

/** The unexpired holder (most recently started, if several), or null when free. */
export function currentHolder(db: Database, now = Date.now()): LeaseHolder | null {
  const row = db
    .query<LeaseRow, [number, number]>(
      `SELECT expires_at, pid, role, started_at FROM delivery_lease
       WHERE expires_at > ? AND expires_at <= ? AND pid IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(now, now + LEASE_SANITY_MS);
  if (!row || row.pid === null) {
    return null;
  }
  return {
    expiresAt: row.expires_at,
    pid: row.pid,
    role: row.role ?? 'unknown',
    startedAt: row.started_at ?? now,
  };
}

/**
 * Atomically take one kind if it is free or expired. One UPDATE decides the
 * winner, so concurrent callers cannot both succeed.
 */
function tryAcquireKind(
  db: Database,
  kind: LeaseKind,
  role: LeaseRole,
  token: string,
  now: number,
): boolean {
  const row = db
    .query<{ token: string }, [string, number, string, number, number, string, number, number]>(
      `UPDATE delivery_lease
         SET token = ?, pid = ?, role = ?, started_at = ?, expires_at = ?
       WHERE kind = ? AND (expires_at <= ? OR expires_at > ? + ${LEASE_SANITY_MS})
       RETURNING token`,
    )
    .get(token, process.pid, role, now, now + LEASE_TTL_MS, kind, now, now);
  return row?.token === token;
}

function release(db: Database, token: string): void {
  try {
    db.query(
      'UPDATE delivery_lease SET expires_at = 0, token = NULL, pid = NULL WHERE token = ?',
    ).run(token);
  } catch {
    // The TTL frees it regardless.
  }
}

/**
 * Take every kind the role needs, or none (a partial hold is released again), plus
 * whichever optional kinds are free. Returns the kinds held, or null.
 */
function tryAcquire(db: Database, role: LeaseRole, token: string): LeaseKind[] | null {
  const now = Date.now();
  const held: LeaseKind[] = [];
  for (const kind of KINDS_FOR_ROLE[role]) {
    if (!tryAcquireKind(db, kind, role, token, now)) {
      release(db, token);
      return null;
    }
    held.push(kind);
  }
  for (const kind of OPTIONAL_KINDS_FOR_ROLE[role] ?? []) {
    if (tryAcquireKind(db, kind, role, token, now)) {
      held.push(kind);
    }
  }
  return held;
}

/**
 * Run `fn` while holding the role's lease(s), renewing on a timer so a long
 * network await does not let it lapse. Returns `{ held: false }` — without
 * running `fn` — when someone else holds one; callers back off, they do not crash.
 *
 * `waitMs` is for foreground commands only (`aiot import`, `aiot drain --wait`):
 * poll for a holder that is expected to finish on its own. Daemons and background
 * drainers never wait; they come back on their next tick or exit.
 *
 * Losing a lease aborts `lease.signal`; pass it to every fetch so in-flight work
 * stops instead of running on beside the new holder.
 */
export async function withLease<T>(
  db: Database,
  role: LeaseRole,
  fn: (lease: Lease) => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<{ held: true; value: T } | { held: false }> {
  const token = randomUUID();
  const giveUpAt = Date.now() + (opts.waitMs ?? 0);
  let kinds = tryAcquire(db, role, token);
  while (kinds === null) {
    if (Date.now() >= giveUpAt) {
      return { held: false };
    }
    await Bun.sleep(1_000);
    kinds = tryAcquire(db, role, token);
  }
  const heldKinds: LeaseKind[] = kinds;
  const abort = new AbortController();
  let lost = false;
  const renew = (): boolean => {
    if (lost) {
      return false;
    }
    try {
      const rows = db
        .query<{ kind: string }, [number, string]>(
          'UPDATE delivery_lease SET expires_at = ? WHERE token = ? RETURNING kind',
        )
        .all(Date.now() + LEASE_TTL_MS, token);
      if (rows.length < heldKinds.length) {
        lost = true;
        log('warn', 'lease.lost', { role });
        abort.abort(new Error('delivery lease lost'));
        release(db, token);
        return false;
      }
    } catch (err) {
      // A busy database is not a lost lease. The TTL leaves room for a retry on
      // the next tick; only a definitive "someone else owns it" aborts.
      log('warn', 'lease.renew_failed', { message: (err as Error).message, role });
    }
    return true;
  };
  const timer = setInterval(renew, LEASE_RENEW_MS);
  try {
    const value = await fn({
      check: renew,
      kinds: heldKinds,
      get lost() {
        return lost;
      },
      signal: abort.signal,
      tryAdd: (kind) => {
        if (heldKinds.includes(kind)) {
          return true;
        }
        if (!lost && tryAcquireKind(db, kind, role, token, Date.now())) {
          heldKinds.push(kind);
          return true;
        }
        return false;
      },
    });
    return { held: true, value };
  } finally {
    clearInterval(timer);
    release(db, token);
  }
}

/** Record that a drain pass finished with nothing left due and no failure. */
export function recordDrainOk(db: Database, now = Date.now()): void {
  db.query('UPDATE drain_state SET last_drain_ok_at = ? WHERE id = 1').run(now);
}

export const SPAWN_CLAIM_MS = 10_000;

/**
 * Nothing that would make a spawned drainer pointless is running: no one holds
 * `events` (the flusher, a drainer, ...) and no drainer holds anything. A holder of
 * `transcripts` alone — a resident shipper, an `aiot import` — does NOT block a
 * spawn: that drainer delivers the events and leaves the transcripts to the holder.
 * Blocking on any lease stranded every hook that fired while an import ran.
 */
const NO_LEASE_HELD = `NOT EXISTS (
  SELECT 1 FROM delivery_lease
  WHERE expires_at > ?1 AND expires_at <= ?1 + ${LEASE_SANITY_MS}
    AND (kind = 'events' OR role = 'drain')
)`;

/**
 * Hook-side: win the right to spawn a drainer. True only when the install mode
 * is on-demand, nothing is holding `events` or running as a drainer (see
 * NO_LEASE_HELD), and nobody claimed a spawn in the
 * last SPAWN_CLAIM_MS, decided on the connection the hook already has open, so a
 * burst of simultaneous Stop hooks (or the gap between a spawn and the drainer
 * taking its lease) starts one process, not one per hook.
 *
 * The claim is cleared by the drainer the moment it holds the lease
 * (`clearSpawnClaim`): from then on the held lease is what stops a spawn, and a
 * hook that fires while the drainer is mid-pass is picked up by the drainer's own
 * re-check rather than waiting out a 10 s timer.
 */
export function claimDrainerSpawn(
  db: Database,
  now = Date.now(),
  opts: { bypassHold?: boolean } = {},
): boolean {
  // `spawn_hold_until` is the failure backoff (see `holdSpawns`). A SessionEnd may
  // bypass it — the user is leaving, and this is the last chance to ship that
  // session — but never the short claim, which is what dedupes a burst.
  const holdOk = opts.bypassHold ? '1' : 'spawn_hold_until <= ?1';
  // Read first: in resident mode, or while a drainer holds the lease, this keeps
  // the terminal hook from taking the write lock for a claim it cannot win.
  const open = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM drain_state
       WHERE id = 1 AND mode = 'on-demand' AND spawn_claimed_until <= ?1 AND ${holdOk}
         AND ${NO_LEASE_HELD}`,
    )
    .get(now);
  if (!open) {
    return false;
  }
  // The UPDATE re-checks the same condition, so of several hooks that all saw
  // "open" exactly one wins.
  const row = db
    .query<{ id: number }, [number, number]>(
      `UPDATE drain_state SET spawn_claimed_until = ?2
       WHERE id = 1 AND mode = 'on-demand' AND spawn_claimed_until <= ?1 AND ${holdOk}
         AND ${NO_LEASE_HELD}
       RETURNING id`,
    )
    .get(now, now + SPAWN_CLAIM_MS);
  return row !== null;
}

/** The shortest, and longest, a failing environment is left alone by new drainers. */
export const SPAWN_HOLD_FLOOR_MS = 30_000;
export const SPAWN_HOLD_CAP_MS = 5 * 60_000;

/**
 * A pass that ended in a transport, token or auth failure: stop hooks from starting
 * a drainer for `ms` (at least SPAWN_HOLD_FLOOR_MS, at most SPAWN_HOLD_CAP_MS).
 *
 * The retry time on a row only holds back rows that already failed; every Stop adds
 * a NEW due row, and the spawn claim is cleared the moment a drainer takes its
 * lease. Without this a refused port made every winning terminal hook spawn a
 * drainer that failed again (30 Stops 100 ms apart: 30 processes). SessionEnd
 * bypasses it.
 */
export function holdSpawns(db: Database, ms: number, now = Date.now()): void {
  const hold = Math.min(SPAWN_HOLD_CAP_MS, Math.max(SPAWN_HOLD_FLOOR_MS, ms));
  db.query('UPDATE drain_state SET spawn_hold_until = ? WHERE id = 1').run(now + hold);
}

export function clearSpawnHold(db: Database): void {
  db.query('UPDATE drain_state SET spawn_hold_until = 0 WHERE id = 1').run();
}

/**
 * How many drain passes in a row ended in a transport failure. A drainer has no
 * memory, so this is what lets its retry backoff GROW during an outage instead of
 * restarting at ~1 s in every new process.
 */
export function readFailureStreak(db: Database): number {
  return (
    db.query<{ n: number }, []>('SELECT failure_streak AS n FROM drain_state WHERE id = 1').get()
      ?.n ?? 0
  );
}

export function writeFailureStreak(db: Database, n: number): void {
  db.query('UPDATE drain_state SET failure_streak = ? WHERE id = 1').run(n);
}

/** Is someone currently holding this kind? (Advisory: nothing is taken.) */
export function isLeaseHeld(db: Database, kind: LeaseKind, now = Date.now()): boolean {
  return (
    db
      .query<{ one: number }, [string, number, number]>(
        'SELECT 1 AS one FROM delivery_lease WHERE kind = ? AND expires_at > ? AND expires_at <= ?',
      )
      .get(kind, now, now + LEASE_SANITY_MS) !== null
  );
}

export function clearSpawnClaim(db: Database): void {
  db.query('UPDATE drain_state SET spawn_claimed_until = 0 WHERE id = 1').run();
}

export type InstallMode = 'resident' | 'on-demand';

export function readMode(db: Database): InstallMode {
  const row = db.query<{ mode: string }, []>('SELECT mode FROM drain_state WHERE id = 1').get();
  return row?.mode === 'on-demand' ? 'on-demand' : 'resident';
}

export function writeMode(db: Database, mode: InstallMode): void {
  db.query('UPDATE drain_state SET mode = ? WHERE id = 1').run(mode);
}

// ── Rejected token (so a drainer, which has no memory, re-probes like the daemons) ──

/** A fingerprint, never the token: queue.db is readable by tooling that must not see credentials. */
function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

export function recordRejectedToken(db: Database, token: string, now = Date.now()): void {
  db.query('UPDATE drain_state SET rejected_token_hash = ?, rejected_at = ? WHERE id = 1').run(
    tokenFingerprint(token),
    now,
  );
}

export function clearRejectedToken(db: Database): void {
  db.query(
    'UPDATE drain_state SET rejected_token_hash = NULL, rejected_at = NULL WHERE id = 1',
  ).run();
}

/**
 * True while `token` is the one ingest last rejected and the re-probe interval
 * has not passed — the same rule the resident flusher and shipper apply in
 * memory. A different token (after `aiot login`) is always tried at once.
 */
export function isTokenRejected(db: Database, token: string, now = Date.now()): boolean {
  const row = db
    .query<{ h: string | null; at: number | null }, []>(
      'SELECT rejected_token_hash AS h, rejected_at AS at FROM drain_state WHERE id = 1',
    )
    .get();
  return (
    row?.h === tokenFingerprint(token) &&
    row.at !== null &&
    now - row.at < REJECTED_TOKEN_REPROBE_MS
  );
}

export type DrainStatus = {
  holder: LeaseHolder | null;
  lastDrainOkAt: number | null;
  mode: InstallMode;
};

export function readDrainStatus(db: Database, now = Date.now()): DrainStatus {
  const row = db
    .query<{ last_drain_ok_at: number | null }, []>(
      'SELECT last_drain_ok_at FROM drain_state WHERE id = 1',
    )
    .get();
  return {
    holder: currentHolder(db, now),
    lastDrainOkAt: row?.last_drain_ok_at ?? null,
    mode: readMode(db),
  };
}

/** True when `pid` is one of our own binaries — never signal an unrelated process. */
function isAiotProcess(pid: number): boolean {
  try {
    // `comm` is the executable's name, not the command line: a path or an
    // argument that merely contains "aiot" must not qualify.
    const out = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm='], { stderr: 'ignore' });
    return basename(new TextDecoder().decode(out.stdout).trim()).startsWith('aiot');
  } catch {
    return false;
  }
}

/** Pids of every unexpired lease holder other than this process. */
function holderPids(db: Database): number[] {
  const now = Date.now();
  const rows = db
    .query<{ pid: number }, [number, number]>(
      'SELECT DISTINCT pid FROM delivery_lease WHERE expires_at > ? AND expires_at <= ? AND pid IS NOT NULL',
    )
    .all(now, now + LEASE_SANITY_MS);
  return rows.map((r) => r.pid).filter((pid) => pid !== process.pid);
}

/**
 * Stop whoever holds a lease (`uninstall`, `purge-local`, a mode switch), so a
 * drainer cannot keep shipping from — or recreate — state that was just removed,
 * and two drainers never coexist. Returns false only when a holder could not be
 * stopped (it is not ours to signal).
 */
export async function stopLeaseHolder(db: Database): Promise<boolean> {
  let ok = true;
  for (const pid of holderPids(db)) {
    if (!isAiotProcess(pid)) {
      log('warn', 'lease.holder_not_aiot', { pid });
      ok = false;
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone: the row below is all that is left to clear.
    }
    const until = Date.now() + 3_000;
    while (Date.now() < until && isAiotProcess(pid)) {
      await Bun.sleep(100);
    }
    if (isAiotProcess(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    // A killed holder cannot release: free its rows now instead of after the TTL.
    db.query(
      'UPDATE delivery_lease SET expires_at = 0, token = NULL, pid = NULL WHERE pid = ?',
    ).run(pid);
  }
  return ok;
}

/**
 * Stop the lease holder(s) of an existing queue.db; creates nothing when there is
 * none. `resetMode` also sets the install mode back to `resident` FIRST, so hooks
 * that survive an uninstall (pasted snippets, project-level settings, MDM-managed
 * configs) stop spawning drainers before the running one is stopped.
 */
export async function stopLeaseHolderIfAny(opts: { resetMode?: boolean } = {}): Promise<boolean> {
  if (!existsSync(queuePath())) {
    return true;
  }
  const reader = openQueueReader(queuePath());
  try {
    if (opts.resetMode) {
      writeMode(reader.db, 'resident');
    }
    return await stopLeaseHolder(reader.db);
  } finally {
    reader.close();
  }
}
