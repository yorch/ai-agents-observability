import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { queuePath } from './paths';

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
  // 0o700: `~/.aiot` holds this queue, whose rows are full event payloads — cwd
  // paths, repo and project names, tool arguments. Default-mode 0o755 left all
  // of that readable by every local account. `identity.json` was already 0o600;
  // this brings the directory and the queue in line with it, and with the
  // per-session state dirs the adapters create.
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const db = new Database(path, { create: true });
  // The DB file itself: bun:sqlite creates it 0o644, and WAL/shm siblings
  // inherit the directory. Narrow it after open, best-effort — a failure here
  // must not stop telemetry.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-fatal: a filesystem without POSIX modes, or a pre-existing file we
    // do not own.
  }

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
