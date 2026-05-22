import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { backoffSleep } from './lib/backoff';
import { log } from './lib/log';
import { identityPath, telemetryHome } from './lib/paths';
import { openQueueReader } from './lib/queue-reader';

const INGEST_BASE_URL = process.env.INGEST_BASE_URL ?? 'http://localhost:4000';
const BATCH_SIZE = 100;
const IDLE_INTERVAL_MS = 5_000;
const HIGH_WATER_MARK = 50;
const MAX_ATTEMPTS = 10;

// ── State file ────────────────────────────────────────────────────────────────

export type FlusherStatus = {
  queueDepth: number;
  lastFlushAt: string | null;
  lastError: string | null;
};

function flusherStatePath(): string {
  return `${telemetryHome()}/flusher-state.json`;
}

function readFlusherState(): FlusherStatus {
  try {
    const raw = readFileSync(flusherStatePath(), 'utf8');
    return JSON.parse(raw) as FlusherStatus;
  } catch {
    return { queueDepth: 0, lastFlushAt: null, lastError: null };
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

// ── JWT token ─────────────────────────────────────────────────────────────────

function loadJwt(): string | null {
  try {
    const raw = readFileSync(identityPath(), 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed.token;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Flusher loop ──────────────────────────────────────────────────────────────

export async function runFlusher(): Promise<void> {
  const dbPath = `${telemetryHome()}/queue.db`;
  const reader = openQueueReader(dbPath);

  log('info', 'flusher.start', { ingestBaseUrl: INGEST_BASE_URL });

  let consecutiveFailures = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = reader.drain(BATCH_SIZE);

    if (rows.length === 0) {
      await Bun.sleep(IDLE_INTERVAL_MS);
      continue;
    }

    const jwt = loadJwt();
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
    const body = JSON.stringify({ events, session_context: null });

    let success = false;
    let attempt = consecutiveFailures;

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
      } else if (res.status >= 400 && res.status < 500) {
        // 4xx (non-401): bad data, server won't accept — delete and move on
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
        reader.markAttempt(eventIds);
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
      reader.markAttempt(eventIds);
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
}
