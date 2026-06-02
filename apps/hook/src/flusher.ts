import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { backoffSleep } from './lib/backoff';
import { loadHookToken } from './lib/identity';
import { INGEST_BASE_URL } from './lib/ingest';
import { log } from './lib/log';
import { flusherStatePath, telemetryHome } from './lib/paths';
import { openQueueReader } from './lib/queue-reader';

const BATCH_SIZE = 100;
const IDLE_INTERVAL_MS = 5_000;
const HIGH_WATER_MARK = 50;

// ── State file ────────────────────────────────────────────────────────────────

export type FlusherStatus = {
  queueDepth: number;
  lastFlushAt: string | null;
  lastError: string | null;
};

function readFlusherState(): FlusherStatus {
  try {
    const raw = readFileSync(flusherStatePath(), 'utf8');
    return JSON.parse(raw) as FlusherStatus;
  } catch {
    return { lastError: null, lastFlushAt: null, queueDepth: 0 };
  }
}

function writeFlusherState(state: FlusherStatus): void {
  try {
    const path = flusherStatePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // swallow — state file is best-effort
  }
}

export function getFlusherStatus(): FlusherStatus {
  return readFlusherState();
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

// ── Flusher loop ──────────────────────────────────────────────────────────────

export async function runFlusher(): Promise<void> {
  const dbPath = `${telemetryHome()}/queue.db`;
  const reader = openQueueReader(dbPath);

  log('info', 'flusher.start', { ingestBaseUrl: INGEST_BASE_URL });

  // Bump the per-row attempt counter, then prune any row that just crossed the
  // cap. Pruning only here (right after a bump) avoids a full table scan on
  // every idle loop tick — a markAttempt is the only thing that can newly
  // abandon a row. Data loss at the cap is intentional (P1-021) but logged.
  const markAttemptAndPrune = (ids: string[]): void => {
    reader.markAttempt(ids);
    const dropped = reader.dropAbandoned();
    if (dropped > 0) {
      log('warn', 'flusher.dropped_abandoned', { count: dropped });
    }
  };

  let consecutiveFailures = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = reader.drain(BATCH_SIZE);

      if (rows.length === 0) {
        await Bun.sleep(IDLE_INTERVAL_MS);
        continue;
      }

      const jwt = loadHookToken();
      if (!jwt) {
        log('warn', 'flusher.no_token', {
          hint: 'Run `claude-telemetry login` to authenticate',
        });
        writeFlusherState({
          ...readFlusherState(),
          lastError: 'No auth token — run `claude-telemetry login`',
        });
        await Bun.sleep(IDLE_INTERVAL_MS);
        continue;
      }

      const eventIds = rows.map((r) => r.event_id);
      const events = rows.map((r) => JSON.parse(r.payload_json) as unknown);
      const body = JSON.stringify(buildBatchEnvelope(events));

      let success = false;
      const attempt = consecutiveFailures;

      try {
        const res = await fetch(`${INGEST_BASE_URL}/v1/events`, {
          body,
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        });

        if (res.status >= 200 && res.status < 300) {
          // Success — delete the rows
          reader.delete(eventIds);
          const now = new Date().toISOString();
          writeFlusherState({ lastError: null, lastFlushAt: now, queueDepth: reader.depth() });
          log('info', 'flusher.batch_sent', { count: rows.length, status: res.status });
          consecutiveFailures = 0;
          success = true;
        } else if (res.status === 401) {
          log('error', 'flusher.unauthorized', {
            hint: 'Run `claude-telemetry login` to re-authenticate',
            status: res.status,
          });
          writeFlusherState({
            ...readFlusherState(),
            lastError: `Unauthorized (${res.status}) — re-authentication required`,
          });
          reader.close();
          process.exit(1);
        } else if (res.status === 429) {
          // Rate-limited — explicit server backpressure, NOT a failure. Back off
          // but do NOT markAttempt: counting 429s toward the attempt cap would
          // let sustained throttling push rows past the cap and dropAbandoned()
          // would then permanently delete valid, deliverable events.
          log('warn', 'flusher.rate_limited', { attempt, count: rows.length, status: res.status });
          writeFlusherState({
            ...readFlusherState(),
            lastError: `Rate limited (${res.status})`,
            queueDepth: reader.depth(),
          });
          consecutiveFailures++;
          await backoffSleep(attempt);
        } else if (res.status >= 400 && res.status < 500) {
          // 4xx (non-401, non-429): bad data, server won't accept — delete and move on
          reader.delete(eventIds);
          log('warn', 'flusher.batch_rejected', { count: rows.length, status: res.status });
          writeFlusherState({
            lastError: `Batch rejected by server (${res.status})`,
            lastFlushAt: null,
            queueDepth: reader.depth(),
          });
          consecutiveFailures = 0;
          success = true;
        } else {
          // 5xx — mark attempts and back off
          markAttemptAndPrune(eventIds);
          const errMsg = `Server error ${res.status}`;
          log('warn', 'flusher.batch_failed', { attempt, count: rows.length, status: res.status });
          writeFlusherState({
            ...readFlusherState(),
            lastError: errMsg,
            queueDepth: reader.depth(),
          });
          consecutiveFailures++;
          await backoffSleep(attempt);
        }
      } catch (err) {
        // Network error — mark attempts and back off
        const message = (err as Error).message;
        markAttemptAndPrune(eventIds);
        log('warn', 'flusher.network_error', { attempt, message });
        writeFlusherState({
          ...readFlusherState(),
          lastError: `Network error: ${message}`,
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
    }
  } finally {
    reader.close();
  }
}
