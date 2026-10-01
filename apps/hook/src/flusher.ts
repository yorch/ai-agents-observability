import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { GitContext } from '@ai-agents-observability/schemas';

import { backoffSleep } from './lib/backoff';
import { getGitContext } from './lib/git';
import type { PrSnapshot } from './lib/github-pr';
import { fetchOpenPrNumber, fetchPrSnapshot } from './lib/github-pr';
import { fetchGitHubLogin, fetchUserTeam } from './lib/github-user';
import { loadHookToken, reauthHint } from './lib/identity';
import { getIngestBaseUrl } from './lib/ingest';
import { log } from './lib/log';
import { flusherStatePath, telemetryHome } from './lib/paths';
import { getProjectName } from './lib/project';
import { openQueueReader } from './lib/queue-reader';

const BATCH_SIZE = 100;
/**
 * Wall-clock bound on one event-batch POST. Generous — this is a batch of up to
 * BATCH_SIZE events and the flusher is a background daemon, so the cost of
 * being wrong in the slow direction is one retry, while the cost of having no
 * bound at all is a permanently stalled daemon.
 */
const FLUSH_TIMEOUT_MS = 30_000;
const IDLE_INTERVAL_MS = 5_000;
/** Poll interval while the current token is the one ingest rejected. */
const UNAUTHORIZED_RETRY_MS = 60_000;
const EXPIRY_INTERVAL_MS = 60_000;
const HIGH_WATER_MARK = 50;

// ── State file ────────────────────────────────────────────────────────────────

export type FlusherStatus = {
  queueDepth: number;
  lastFlushAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
};

function readFlusherState(): FlusherStatus {
  try {
    const raw = readFileSync(flusherStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<FlusherStatus>;
    return {
      lastError: parsed.lastError ?? null,
      lastFlushAt: parsed.lastFlushAt ?? null,
      lastHeartbeatAt: parsed.lastHeartbeatAt ?? null,
      queueDepth: parsed.queueDepth ?? 0,
    };
  } catch {
    return { lastError: null, lastFlushAt: null, lastHeartbeatAt: null, queueDepth: 0 };
  }
}

function writeFlusherState(state: FlusherStatus): void {
  try {
    const path = flusherStatePath();
    mkdirSync(dirname(path), { recursive: true });
    // Atomic write: write to a temp file then rename, so a crash mid-write
    // cannot leave a truncated state file that `aiot status` would read as
    // garbage. The rename is atomic on POSIX filesystems.
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, path);
  } catch {
    // swallow — state file is best-effort
  }
}

export function getFlusherStatus(): FlusherStatus {
  return readFlusherState();
}

/**
 * Seconds since the last heartbeat, or null if no heartbeat has ever been
 * recorded. Pure so it can be tested without touching the filesystem.
 */
export function heartbeatAgeSeconds(lastHeartbeat: string | null, now = Date.now()): number | null {
  if (!lastHeartbeat) {
    return null;
  }
  const ts = Date.parse(lastHeartbeat);
  if (Number.isNaN(ts)) {
    return null;
  }
  return Math.max(0, Math.floor((now - ts) / 1000));
}

/** Write a heartbeat timestamp into the state file, preserving other fields.
 * Throttled to once per HEARTBEAT_MIN_INTERVAL_MS to avoid excessive disk I/O
 * on the idle loop (which runs every 5s). */
const HEARTBEAT_MIN_INTERVAL_MS = 30_000; // 30s — 2x/hour, enough for staleness detection
let lastHeartbeatWrittenAt = 0;

function writeHeartbeat(): void {
  const now = Date.now();
  if (now - lastHeartbeatWrittenAt < HEARTBEAT_MIN_INTERVAL_MS) {
    return;
  }
  lastHeartbeatWrittenAt = now;
  const state = readFlusherState();
  writeFlusherState({ ...state, lastHeartbeatAt: new Date().toISOString() });
}

// ── Batch envelope ──────────────────────────────────────────────────────────

/**
 * Build the `POST /v1/events` request body from queued event payloads.
 *
 * `EventsBatchSchema` requires a non-nullable top-level `session_context`
 * envelope — ingest uses it as a repo-attribution fallback. Each event already
 * carries its own context, so we reuse the newest event's context for the
 * envelope. Sending `session_context: null` (the previous behaviour) failed
 * validation with a 400 on every batch, which the flusher then treated as
 * "bad data" and silently deleted — dropping all telemetry end-to-end.
 */
export function buildBatchEnvelope(events: unknown[]): {
  events: unknown[];
  session_context: unknown;
} {
  const newest = (events as Array<{ session_context?: unknown } | null>).findLast(
    (e) => e?.session_context,
  );
  return { events, session_context: newest?.session_context ?? null };
}

// ── Git enrichment ────────────────────────────────────────────────────────────

type EnrichableEvent = {
  session_context?: { cwd?: unknown; git?: GitContext | null } | null;
};

/**
 * Fill in `session_context.git` for events captured without it. The hook
 * deliberately leaves git context null on the hot path (P1-021); the flusher is
 * the documented enrichment point. Results are cached per cwd so a batch
 * spanning many events in one repo runs `git` only once.
 */
export function enrichGitContext(
  events: unknown[],
  resolve: (cwd: string) => GitContext | null = getGitContext,
): void {
  const cache = new Map<string, GitContext | null>();
  for (const ev of events as EnrichableEvent[]) {
    const ctx = ev?.session_context;
    if (!ctx || ctx.git || typeof ctx.cwd !== 'string' || ctx.cwd.length === 0) {
      continue;
    }
    let git = cache.get(ctx.cwd);
    if (git === undefined) {
      git = resolve(ctx.cwd);
      cache.set(ctx.cwd, git);
    }
    if (git) {
      ctx.git = git;
    }
  }
}

// ── PR number enrichment ──────────────────────────────────────────────────────

type GitEnrichedEvent = {
  session_context?: {
    cwd?: string;
    git?: {
      branch?: string | null;
      github_login?: string | null;
      owner?: string | null;
      pr_ci_status?: string;
      pr_number?: number | null;
      pr_review_decision?: string;
      remote_url?: string | null;
      repo?: string | null;
      team?: string | null;
    } | null;
    project_name?: string | null;
  } | null;
};

type PrResolver = (
  owner: string,
  repo: string,
  branch: string,
  remoteUrl: string | null,
) => Promise<number | null>;

/**
 * Populate `session_context.git.pr_number` for events that have git context
 * (owner, repo, branch) but no PR number yet. Results are cached per
 * owner/repo/branch within the batch so at most one lookup runs per branch.
 */
export async function enrichPrNumbers(
  events: unknown[],
  resolve: PrResolver = fetchOpenPrNumber,
): Promise<void> {
  const cache = new Map<string, number | null>();
  for (const ev of events as GitEnrichedEvent[]) {
    const git = ev?.session_context?.git;
    if (!git || git.pr_number != null) {
      continue;
    }
    const { owner, repo, branch, remote_url } = git;
    if (!owner || !repo || !branch) {
      continue;
    }
    const key = `${owner}/${repo}#${branch}`;
    let pr = cache.get(key);
    if (pr === undefined) {
      pr = await resolve(owner, repo, branch, remote_url ?? null);
      cache.set(key, pr ?? null);
    }
    if (pr != null) {
      git.pr_number = pr;
    }
  }
}

// ── PR snapshot enrichment ────────────────────────────────────────────────────

type SnapshotResolver = (owner: string, repo: string, prNumber: number) => PrSnapshot | null;

/**
 * Populate `pr_ci_status` and `pr_review_decision` on events that already
 * have a PR number. Results are cached per owner/repo/prNumber within the
 * batch. Runs synchronously (gh CLI via spawnSync) — safe in the flusher
 * daemon, never on the hook hot path.
 */
export function enrichPrSnapshot(
  events: unknown[],
  resolve: SnapshotResolver = fetchPrSnapshot,
): void {
  const cache = new Map<string, PrSnapshot | null>();
  for (const ev of events as GitEnrichedEvent[]) {
    const git = ev?.session_context?.git;
    if (!git?.owner || !git?.repo || git.pr_number == null) {
      continue;
    }
    if (git.pr_ci_status !== undefined || git.pr_review_decision !== undefined) {
      continue;
    }
    const key = `${git.owner}/${git.repo}#${git.pr_number}`;
    let snap = cache.get(key);
    if (snap === undefined) {
      snap = resolve(git.owner, git.repo, git.pr_number);
      cache.set(key, snap ?? null);
    }
    if (snap) {
      if (snap.ciStatus != null) {
        git.pr_ci_status = snap.ciStatus;
      }
      if (snap.reviewDecision != null) {
        git.pr_review_decision = snap.reviewDecision;
      }
    }
  }
}

// ── GitHub login enrichment ───────────────────────────────────────────────────

/**
 * Populate `session_context.git.github_login` for all events that have git
 * context but no login yet. The resolver is called at most once per batch —
 * the GitHub login is the same user for every event on the same machine.
 */
export function enrichGitHubLogin(
  events: unknown[],
  resolve: () => string | null = fetchGitHubLogin,
): void {
  let resolved = false;
  let login: string | null = null;
  for (const ev of events as GitEnrichedEvent[]) {
    const git = ev?.session_context?.git;
    if (!git || git.github_login !== undefined) {
      continue;
    }
    if (!resolved) {
      login = resolve();
      resolved = true;
    }
    if (login !== null) {
      git.github_login = login;
    }
  }
}

// ── User team enrichment ──────────────────────────────────────────────────────

/**
 * Populate `session_context.git.team` for events that have an `owner` (org)
 * but no team yet. Results are cached per owner within the batch so at most
 * one lookup runs per org.
 */
export function enrichUserTeam(
  events: unknown[],
  resolve: (owner: string) => string | null = fetchUserTeam,
): void {
  const cache = new Map<string, string | null>();
  for (const ev of events as GitEnrichedEvent[]) {
    const git = ev?.session_context?.git;
    if (!git || git.team !== undefined || !git.owner) {
      continue;
    }
    const { owner } = git;
    let team = cache.get(owner);
    if (team === undefined) {
      team = resolve(owner);
      cache.set(owner, team ?? null);
    }
    if (team !== null) {
      git.team = team;
    }
  }
}

// ── Project name enrichment ───────────────────────────────────────────────────

/**
 * Populate `session_context.project_name` by walking up from `cwd` to find
 * the nearest `package.json` with a `name` field. Results are cached per cwd
 * within the batch.
 */
export function enrichProjectName(
  events: unknown[],
  resolve: (cwd: string) => string | null = getProjectName,
): void {
  const cache = new Map<string, string | null>();
  for (const ev of events as GitEnrichedEvent[]) {
    const ctx = ev?.session_context;
    if (!ctx || ctx.project_name !== undefined || typeof ctx.cwd !== 'string' || !ctx.cwd) {
      continue;
    }
    const { cwd } = ctx;
    let name = cache.get(cwd);
    if (name === undefined) {
      name = resolve(cwd);
      cache.set(cwd, name ?? null);
    }
    if (name !== null) {
      ctx.project_name = name;
    }
  }
}

// ── Flusher loop ──────────────────────────────────────────────────────────────

export async function runFlusher(): Promise<void> {
  const dbPath = `${telemetryHome()}/queue.db`;
  const reader = openQueueReader(dbPath);

  const ingestBaseUrl = getIngestBaseUrl();
  log('info', 'flusher.start', { ingestBaseUrl });

  // Bump the per-row attempt counter, then prune any row that just crossed the
  // cap. Pruning only here (right after a bump) avoids a full table scan on
  // every idle loop tick — a markAttempt is the only thing that can newly
  // abandon a row. Data loss at the cap is intentional (P1-021) but logged.
  // Only a real server response may call this: the cap exists to shed batches
  // the server rejects, not to time out an offline laptop (~13 min at the
  // 1s→300s backoff). Offline survival is bounded by row age instead.
  const markAttemptAndPrune = (ids: string[]): void => {
    reader.markAttempt(ids);
    const dropped = reader.dropAbandoned();
    if (dropped > 0) {
      log('warn', 'flusher.dropped_abandoned', { count: dropped });
    }
  };

  let consecutiveFailures = 0;
  // The token ingest last answered 401 to. While loadHookToken() still returns
  // it there is nothing to try, so the loop only waits.
  let rejectedToken: string | null = null;
  let lastExpiryAt = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // One try/catch per iteration: nothing outside the inner fetch handler —
      // dropExpired/drain on a locked or damaged DB, a state-file write — may kill
      // the daemon (the service manager would just restart it into the same
      // fault). Back off and go round again.
      try {
        const jwt = loadHookToken();

        // A token ingest already rejected will be rejected again: don't drain,
        // enrich (gh spawns) or POST until loadHookToken() returns something
        // different. Costs nothing but a heartbeat.
        if (jwt !== null && jwt === rejectedToken) {
          writeHeartbeat();
          await Bun.sleep(UNAUTHORIZED_RETRY_MS);
          continue;
        }

        // Age expiry only runs while the flusher HAS a usable token (one is
        // configured and ingest has not rejected it). While logged out nothing can
        // be delivered, so letting the 7-day clock run would turn "log in again
        // next week" into silent loss. At most once a minute: rows only age on
        // that scale, and a per-tick DELETE is what markAttemptAndPrune avoids.
        if (jwt !== null && Date.now() - lastExpiryAt >= EXPIRY_INTERVAL_MS) {
          lastExpiryAt = Date.now();
          const expired = reader.dropExpired();
          if (expired > 0) {
            log('warn', 'flusher.dropped_expired', { count: expired });
          }
        }
        const rows = reader.drain(BATCH_SIZE);

        if (rows.length === 0) {
          writeHeartbeat();
          await Bun.sleep(IDLE_INTERVAL_MS);
          continue;
        }

        if (!jwt) {
          log('warn', 'flusher.no_token', {
            hint: 'Run `aiot login` to authenticate',
          });
          writeFlusherState({
            ...readFlusherState(),
            lastError: 'No auth token — run `aiot login`',
            lastHeartbeatAt: new Date().toISOString(),
          });
          await Bun.sleep(IDLE_INTERVAL_MS);
          continue;
        }

        // A row whose payload is not JSON can never be sent; left in place it would
        // fail this parse on every iteration and wedge the queue head. Drop it.
        const events: unknown[] = [];
        const eventIds: string[] = [];
        const corrupt: string[] = [];
        for (const r of rows) {
          try {
            events.push(JSON.parse(r.payload_json) as unknown);
            eventIds.push(r.event_id);
          } catch {
            corrupt.push(r.event_id);
          }
        }
        if (corrupt.length > 0) {
          reader.delete(corrupt);
          log('warn', 'flusher.dropped_corrupt', { count: corrupt.length });
        }
        if (events.length === 0) {
          continue;
        }
        enrichGitContext(events);
        await enrichPrNumbers(events);
        enrichPrSnapshot(events);
        enrichGitHubLogin(events);
        enrichUserTeam(events);
        enrichProjectName(events);
        const body = JSON.stringify(buildBatchEnvelope(events));

        let success = false;
        const attempt = consecutiveFailures;

        try {
          const res = await fetch(`${ingestBaseUrl}/v1/events`, {
            body,
            headers: {
              Authorization: `Bearer ${jwt}`,
              'Content-Type': 'application/json',
            },
            method: 'POST',
            // Bun's fetch has no default timeout, and this await is the flusher's
            // only loop. Against a server that accepts the connection and then
            // never answers — a captive portal, a blackholing proxy, an ingest
            // stuck on a DB lock — the daemon blocks here forever: no
            // network_error, no backoff, the queue grows without bound, and
            // `aiot status` keeps reporting the last SUCCESSFUL flush with
            // lastError null, so it reads as healthy. A hang has to become a
            // failure for any of the retry machinery to run (the resulting
            // TimeoutError is counted toward the attempt cap, see the catch).
            // `lib/import-ship.ts` shows the idiom, but only on its `/health`
            // probe — its own two uploads were unbounded as well, and are fixed
            // in the same commit. Nothing that POSTs telemetry was bounded.
            signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
          });

          if (res.status >= 200 && res.status < 300) {
            // Success — delete the rows
            reader.delete(eventIds);
            const now = new Date().toISOString();
            writeFlusherState({
              lastError: null,
              lastFlushAt: now,
              lastHeartbeatAt: now,
              queueDepth: reader.depth(),
            });
            log('info', 'flusher.batch_sent', { count: rows.length, status: res.status });
            consecutiveFailures = 0;
            rejectedToken = null;
            success = true;
          } else if (res.status === 401) {
            // Used to `process.exit(1)`. The service manager restarts the daemon
            // (systemd Restart=always RestartSec=5, launchd KeepAlive), so an
            // expired token became an endless crash loop that also reset the
            // heartbeat. Stay up instead: record the error, leave the rows untouched
            // (no markAttempt — the batch is fine, the credential is not), and
            // remember the rejected token. The top of the loop then only waits
            // (60s) until the token changes, so `aiot login` recovers the daemon
            // without a restart and without re-running gh enrichment every minute.
            const hint = reauthHint();
            log('error', 'flusher.unauthorized', { hint, status: res.status });
            writeFlusherState({
              ...readFlusherState(),
              lastError: `Unauthorized (${res.status}) — ${hint}`,
              lastHeartbeatAt: new Date().toISOString(),
              queueDepth: reader.depth(),
            });
            rejectedToken = jwt;
          } else if (res.status === 429) {
            // Rate-limited — explicit server backpressure, NOT a failure. Back off
            // but do NOT markAttempt: counting 429s toward the attempt cap would
            // let sustained throttling push rows past the cap and dropAbandoned()
            // would then permanently delete valid, deliverable events.
            log('warn', 'flusher.rate_limited', {
              attempt,
              count: rows.length,
              status: res.status,
            });
            writeFlusherState({
              ...readFlusherState(),
              lastError: `Rate limited (${res.status})`,
              lastHeartbeatAt: new Date().toISOString(),
              queueDepth: reader.depth(),
            });
            consecutiveFailures++;
            await backoffSleep(attempt);
          } else if (res.status >= 400 && res.status < 500) {
            // 4xx (non-401, non-429). This used to read "bad data, server won't
            // accept" and `delete` the batch outright, with `consecutiveFailures
            // = 0` and `success = true` — so no backoff either, and the loop went
            // straight to the next batch. That drained the entire queue at full
            // speed, one warn line per batch.
            //
            // The premise was wrong: a 4xx here is usually NOT bad data.
            // `apps/ingest` validates the ENVELOPE strictly and returns 400, but
            // handles individual events tolerantly (routes/events.ts) — so a 400
            // means hook/server contract skew, never a poisoned event. The hook
            // is a binary developers upgrade on their own schedule, so one
            // envelope change server-side silently destroyed all telemetry from
            // every un-upgraded machine. A 404 from a misconfigured ingest URL
            // did the same thing.
            //
            // Now it uses the same bounded machinery as 5xx and timeouts:
            // MAX_ATTEMPTS retries, then dropAbandoned() drops it. A genuinely
            // undeliverable batch still leaves, it just stops taking the rest of
            // the queue with it. The cost is that a poisoned batch holds the head
            // for its attempt budget rather than being discarded at once.
            //
            // 413 is the one status where retrying the identical bytes is futile
            // by construction; splitting the batch is the real answer and is not
            // attempted here.
            markAttemptAndPrune(eventIds);
            log('warn', 'flusher.batch_rejected', {
              attempt,
              count: rows.length,
              status: res.status,
            });
            writeFlusherState({
              ...readFlusherState(),
              lastError: `Batch rejected by server (${res.status})`,
              lastHeartbeatAt: new Date().toISOString(),
              queueDepth: reader.depth(),
            });
            consecutiveFailures++;
            await backoffSleep(attempt);
          } else {
            // 5xx — mark attempts and back off
            markAttemptAndPrune(eventIds);
            const errMsg = `Server error ${res.status}`;
            log('warn', 'flusher.batch_failed', {
              attempt,
              count: rows.length,
              status: res.status,
            });
            writeFlusherState({
              ...readFlusherState(),
              lastError: errMsg,
              lastHeartbeatAt: new Date().toISOString(),
              queueDepth: reader.depth(),
            });
            consecutiveFailures++;
            await backoffSleep(attempt);
          }
        } catch (err) {
          const message = (err as Error).message;
          // A connection error (refused, DNS, unreachable) says nothing about the
          // rows, so it does NOT markAttempt: counting it deleted every queued row
          // after ~13 min offline. Age expiry bounds those instead.
          //
          // A TIMEOUT is different: the connection was made and the server then sat
          // on THIS batch for FLUSH_TIMEOUT_MS. That is a response of sorts, and a
          // batch that always times out (too large, a pathological payload) would
          // otherwise hold the queue head for the full 7 days. It counts like any
          // other server-side failure, under the same cap of 10: each try costs
          // 30s plus backoff, so a batch has to stall for ~13 minutes of tries
          // before it is dropped, which is not tight for a payload of <=100 events.
          const name = (err as Error).name;
          if (name === 'TimeoutError' || name === 'AbortError') {
            markAttemptAndPrune(eventIds);
          }
          log('warn', 'flusher.network_error', { attempt, message });
          writeFlusherState({
            ...readFlusherState(),
            lastError: `Network error: ${message}`,
            lastHeartbeatAt: new Date().toISOString(),
            queueDepth: reader.depth(),
          });
          consecutiveFailures++;
          await backoffSleep(attempt);
        }

        if (success) {
          const depth = reader.depth();
          if (depth < HIGH_WATER_MARK) {
            await Bun.sleep(IDLE_INTERVAL_MS);
          }
          // else: loop immediately to drain more rows
        }
      } catch (err) {
        log('error', 'flusher.iteration_failed', { message: (err as Error).message });
        const attempt = consecutiveFailures++;
        await backoffSleep(attempt);
      }
    }
  } finally {
    reader.close();
  }
}
