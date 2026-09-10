import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { log } from './log';
import { queuePath } from './paths';

const DEFAULT_MAX_EVENTS = 50_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

function queueMaxEvents(): number {
  const v = process.env.AIOT_QUEUE_MAX_EVENTS;
  if (v !== undefined) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_MAX_EVENTS;
}

function queueMaxBytes(): number {
  const v = process.env.AIOT_QUEUE_MAX_BYTES;
  if (v !== undefined) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_MAX_BYTES;
}

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
  const countStmt = db.prepare<{ c: number }, []>('SELECT COUNT(*) AS c FROM events_queue');
  // Delete the N oldest rows by ts. event_id is a deterministic tie-breaker so
  // rows with identical ts values are pruned in a stable order, never randomly
  // picking the just-enqueued row among ties. The ts index makes the subquery
  // a sorted scan rather than a full-table sort.
  const pruneOldestStmt = db.prepare(
    'DELETE FROM events_queue WHERE event_id IN (SELECT event_id FROM events_queue ORDER BY ts ASC, event_id ASC LIMIT ?)',
  );

  return {
    close() {
      db.close();
    },
    enqueue(event) {
      // Wrap insert + cap enforcement in a transaction so COUNT and DELETE are
      // atomic: without this, a concurrent flusher process could insert/delete
      // between the count and the prune, making the count stale. The
      // transaction is short (one INSERT + at most two queries) so the lock
      // overhead is negligible on the hot path.
      db.transaction(() => {
        insert.run(event.event_id, event.ts, event.payload_json);

        // ── Queue caps ──────────────────────────────────────────────────────
        // Without a bound the queue grows without limit when the flusher is
        // offline or the network is down. Prune oldest rows when either the
        // event count or the on-disk byte size exceeds its cap.
        //
        // COUNT(*) over an indexed table is O(1) in SQLite (it uses the
        // sqlite_stat1 metadata, not a full scan). The stat() syscall is a
        // single inode lookup. Both are hot-path-cheap.
        const maxEvents = queueMaxEvents();
        const depth = countStmt.get()?.c ?? 0;
        if (depth > maxEvents) {
          const excess = depth - maxEvents;
          pruneOldestStmt.run(excess);
          log('warn', 'queue.pruned_events', { count: excess, depth, max: maxEvents });
        }

        const maxBytes = queueMaxBytes();
        // In WAL mode, the .db file lags behind the .db-wal file until a
        // checkpoint. Measure both to get an accurate picture of on-disk usage.
        // Without the -wal file, the byte cap would silently undercount and
        // fail to prune when it should.
        let fileSize = 0;
        try {
          fileSize = statSync(path).size;
          fileSize += statSync(`${path}-wal`).size;
        } catch {
          // -wal may not exist yet (fresh DB, or after checkpoint). The .db
          // size alone is still a useful lower bound.
        }
        if (fileSize > maxBytes) {
          // Prune a proportional batch: the fraction of rows corresponding to
          // the overflow fraction. One prune + one re-stat is enough — if it
          // is still over, the next enqueue prunes more. This converges without
          // a tight loop on the hot path.
          //
          // Note: SQLite does not shrink the .db file after DELETE (free pages
          // stay in the file), so the byte cap may remain triggered until a
          // checkpoint runs. The event-count cap is the primary bound; the
          // byte cap is a backstop for large payloads.
          const overflowFraction = (fileSize - maxBytes) / fileSize;
          const currentDepth = countStmt.get()?.c ?? 0;
          const toPrune = Math.max(1, Math.ceil(currentDepth * overflowFraction));
          pruneOldestStmt.run(toPrune);
          log('warn', 'queue.pruned_bytes', { count: toPrune, fileSize, max: maxBytes });
        }
      })();
    },
  };
}
