import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureSchema } from './queue-schema';

export type QueueRow = {
  event_id: string;
  payload_json: string;
  ts: string;
  attempts: number;
  /** 1 once enrichment has been written back into `payload_json`. */
  enriched: number;
};

/**
 * Max server rejections (5xx, non-401/429 4xx) before a row is abandoned
 * (dropped) by the flusher, plus request timeouts when /health shows the server
 * is up (so the batch itself is the problem). Connection errors, timeouts with
 * the server unreachable, and 429s never count — see the flusher loop — so being
 * offline cannot burn this budget.
 */
export const MAX_ATTEMPTS = 10;

/**
 * Rows whose event `ts` is older than this are dropped. With attempts no longer
 * counting offline time, age is what bounds the queue's lifetime.
 *
 * Why 7 days, stated exactly: a late event is NOT worthless on arrival — ingest
 * still counts it into the session and adds its cost to `total_cost_usd`
 * (apps/ingest/src/lib/upsert-session.ts, on arrival). What it loses is the
 * later enrichment: the link-turn-events and compute-cost-attribution jobs look
 * back 7 days, keyed on `sessions.ended_at`, so an older event is never linked
 * to its turn or attributed.
 *
 * Age is measured from the event's own `ts`, not from when it was enqueued, and
 * there is deliberately no enqueue-time column. Consequence: a first Stop with
 * no transcript cursor re-enqueues a long session's old turns with their
 * original `ts`, and any older than 7 days are expired here rather than sent.
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows are due when `next_attempt_at <= cutoff`; a cutoff past every ISO string ignores it. */
function retryCutoff(honourRetryAt: boolean): string {
  return honourRetryAt ? new Date().toISOString() : '\uffff';
}

export type QueueReader = {
  /** The open connection, for the delivery lease. */
  readonly db: Database;
  /**
   * True when at least one row is due — a cheap probe that does not read payloads.
   * `honourRetryAt: false` ignores the persisted retry time (the resident daemon,
   * which keeps its own in-memory backoff, as before).
   */
  hasDue(honourRetryAt?: boolean): boolean;
  /** SELECT up to `limit` due rows (attempts < MAX_ATTEMPTS, not deferred) ORDER BY ts */
  drain(limit: number, honourRetryAt?: boolean): QueueRow[];
  /**
   * Hold rows back until `untilMs` (epoch ms). Persisted on the row, so a fresh
   * process — the next on-demand drainer — honours a backoff set by the last one.
   */
  defer(eventIds: string[], untilMs: number): void;
  /**
   * Persist enrichment into the rows. `complete` marks them enriched, so a retry
   * reuses the stored payload instead of re-resolving; a partial result (a lookup
   * that could not be answered) is stored but left open for a later attempt.
   */
  saveEnriched(rows: Array<{ event_id: string; payload_json: string }>, complete: boolean): void;
  /**
   * Make every deferred row due. Called when the server has just answered 2xx: rows
   * held back for a transport failure are not in trouble — the server is simply
   * back — and must not wait out a backoff set while it was down. (Attempt counters
   * from real rejections are separate and untouched.)
   */
  clearDeferrals(): void;
  /** ts of the oldest queued row, deferred or not — the "is it stuck" signal. */
  oldestTs(): string | null;
  /** UPDATE: attempts++, attempted_at=now() */
  markAttempt(eventIds: string[]): void;
  /** DELETE WHERE event_id IN (...) */
  delete(eventIds: string[]): void;
  /** DELETE WHERE attempts >= MAX_ATTEMPTS — returns count dropped. */
  dropAbandoned(): number;
  /** DELETE WHERE ts < now - MAX_AGE_MS — returns count dropped. */
  dropExpired(now?: number): number;
  /** COUNT(*) WHERE attempts < MAX_ATTEMPTS */
  depth(): number;
  /** MAX(attempted_at) */
  lastAttemptedAt(): string | null;
  close(): void;
};

/** Opens the DB in WAL mode (same as queue.ts writer). */
export function openQueueReader(dbPath: string): QueueReader {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, readonly: false });

  // Default busy_timeout is 0, so any overlap with a hook's enqueue transaction
  // threw SQLITE_BUSY out of the flusher loop. This is a daemon off the hot path
  // (unlike queue.ts), so it can afford to wait much longer than the hook does.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = memory;');
  ensureSchema(db);

  const drainStmt = db.prepare<QueueRow, [string, number]>(
    `SELECT event_id, payload_json, ts, attempts, enriched FROM events_queue
     WHERE attempts < ${MAX_ATTEMPTS} AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY ts LIMIT ?`,
  );
  const hasDueStmt = db.prepare<{ one: number }, [string]>(
    `SELECT 1 AS one FROM events_queue
     WHERE attempts < ${MAX_ATTEMPTS} AND (next_attempt_at IS NULL OR next_attempt_at <= ?) LIMIT 1`,
  );
  const oldestStmt = db.prepare<{ oldest: string | null }, []>(
    'SELECT MIN(ts) AS oldest FROM events_queue',
  );

  const depthStmt = db.prepare<{ c: number }, []>(
    `SELECT COUNT(*) AS c FROM events_queue WHERE attempts < ${MAX_ATTEMPTS}`,
  );

  const lastAttemptedAtStmt = db.prepare<{ last: string | null }, []>(
    'SELECT MAX(attempted_at) AS last FROM events_queue',
  );

  const dropAbandonedStmt = db.prepare(
    `DELETE FROM events_queue WHERE attempts >= ${MAX_ATTEMPTS}`,
  );

  const dropExpiredStmt = db.prepare('DELETE FROM events_queue WHERE ts < ?');

  return {
    clearDeferrals(): void {
      db.exec('UPDATE events_queue SET next_attempt_at = NULL WHERE next_attempt_at IS NOT NULL');
    },
    close(): void {
      db.close();
    },

    db,

    defer(eventIds: string[], untilMs: number): void {
      if (eventIds.length === 0) {
        return;
      }
      const placeholders = eventIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE events_queue SET next_attempt_at = ? WHERE event_id IN (${placeholders})`,
      ).run(new Date(untilMs).toISOString(), ...eventIds);
    },

    delete(eventIds: string[]): void {
      if (eventIds.length === 0) {
        return;
      }
      const placeholders = eventIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM events_queue WHERE event_id IN (${placeholders})`).run(...eventIds);
    },

    depth(): number {
      const row = depthStmt.get();
      return row?.c ?? 0;
    },
    drain(limit: number, honourRetryAt = true): QueueRow[] {
      return drainStmt.all(retryCutoff(honourRetryAt), limit);
    },

    dropAbandoned(): number {
      // Rows that have hit the attempt cap are unsendable (poison batch or a
      // permanently-rejecting endpoint). Drop them so the DB doesn't grow
      // unbounded and a head-of-line poison row can't block the queue forever.
      return dropAbandonedStmt.run().changes;
    },

    dropExpired(now = Date.now()): number {
      // `ts` is always `toISOString()` output (UTC, fixed width), so string
      // comparison is chronological and the ts index serves the range scan.
      return dropExpiredStmt.run(new Date(now - MAX_AGE_MS).toISOString()).changes;
    },

    hasDue(honourRetryAt = true): boolean {
      return hasDueStmt.get(retryCutoff(honourRetryAt)) !== null;
    },

    lastAttemptedAt(): string | null {
      const row = lastAttemptedAtStmt.get();
      return row?.last ?? null;
    },

    markAttempt(eventIds: string[]): void {
      if (eventIds.length === 0) {
        return;
      }
      const placeholders = eventIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE events_queue SET attempts = attempts + 1, attempted_at = ? WHERE event_id IN (${placeholders})`,
      ).run(new Date().toISOString(), ...eventIds);
    },

    oldestTs(): string | null {
      return oldestStmt.get()?.oldest ?? null;
    },

    saveEnriched(rows, complete): void {
      const update = db.prepare(
        `UPDATE events_queue SET payload_json = ?, enriched = ${complete ? 1 : 0} WHERE event_id = ?`,
      );
      db.transaction(() => {
        for (const r of rows) {
          update.run(r.payload_json, r.event_id);
        }
      })();
    },
  };
}
