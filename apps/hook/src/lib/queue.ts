import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';

import { queuePath } from './paths.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events_queue (
  event_id     TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempted_at TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS events_queue_ts_idx ON events_queue (ts);
`;

export type QueuedEvent = {
  event_id: string;
  payload_json: string;
  ts: string;
};

export type Queue = {
  close(): void;
  enqueue(event: QueuedEvent): void;
};

export function openQueue(path = queuePath()): Queue {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });

  // WAL + NORMAL is the speed/durability sweet spot for an append-only queue.
  // temp_store=memory keeps spill space off disk.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = memory;');
  db.exec(SCHEMA);

  const insert = db.prepare(
    'INSERT OR IGNORE INTO events_queue (event_id, ts, payload_json) VALUES (?, ?, ?)',
  );

  return {
    close() {
      db.close();
    },
    enqueue(event) {
      insert.run(event.event_id, event.ts, event.payload_json);
    },
  };
}
