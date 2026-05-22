import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type QueueRow = {
  event_id: string;
  payload_json: string;
  ts: string;
  attempts: number;
};

export type QueueReader = {
  /** SELECT up to `limit` rows WHERE attempts < 10 ORDER BY ts */
  drain(limit: number): QueueRow[];
  /** UPDATE: attempts++, attempted_at=now() */
  markAttempt(eventIds: string[]): void;
  /** DELETE WHERE event_id IN (...) */
  delete(eventIds: string[]): void;
  /** COUNT(*) WHERE attempts < 10 */
  depth(): number;
  /** MAX(attempted_at) */
  lastAttemptedAt(): string | null;
  close(): void;
};

/** Opens the DB in WAL mode (same as queue.ts writer). */
export function openQueueReader(dbPath: string): QueueReader {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, readonly: false });

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = memory;');

  const drainStmt = db.prepare<QueueRow, [number]>(
    'SELECT event_id, payload_json, ts, attempts FROM events_queue WHERE attempts < 10 ORDER BY ts LIMIT ?',
  );

  const depthStmt = db.prepare<{ c: number }, []>(
    'SELECT COUNT(*) AS c FROM events_queue WHERE attempts < 10',
  );

  const lastAttemptedAtStmt = db.prepare<{ last: string | null }, []>(
    'SELECT MAX(attempted_at) AS last FROM events_queue',
  );

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
