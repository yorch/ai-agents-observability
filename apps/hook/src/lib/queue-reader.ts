import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type QueueRow = {
  event_id: string;
  payload_json: string;
  ts: string;
  attempts: number;
};

/**
 * Max server rejections (5xx, non-401/429 4xx) before a row is abandoned
 * (dropped) by the flusher. Network errors, timeouts and 429s never count — see
 * the flusher loop — so being offline cannot burn this budget.
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

export type QueueReader = {
  /** SELECT up to `limit` rows WHERE attempts < MAX_ATTEMPTS ORDER BY ts */
  drain(limit: number): QueueRow[];
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

  const drainStmt = db.prepare<QueueRow, [number]>(
    `SELECT event_id, payload_json, ts, attempts FROM events_queue WHERE attempts < ${MAX_ATTEMPTS} ORDER BY ts LIMIT ?`,
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
    close(): void {
      db.close();
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
    drain(limit: number): QueueRow[] {
      return drainStmt.all(limit);
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
  };
}
