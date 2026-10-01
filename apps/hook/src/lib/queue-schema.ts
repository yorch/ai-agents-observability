import type { Database } from 'bun:sqlite';

/**
 * The queue.db schema, shared by the hook's writer and every reader/daemon so
 * whichever process touches the file first leaves it in the same shape.
 *
 * - `events_queue` is the event queue.
 * - `drain_state` is a single row: the install mode, the spawn claim the hook uses
 *   to start at most one drainer, the time of the last clean drain, and the token
 *   ingest last rejected (a hash, never the token), and how many drain passes in a
 *   row ended in a transport failure (the on-disk memory behind the drainer's
 *   growing backoff), plus the spawn hold: while a drainer's last pass failed, hooks
 *   do not start another one (see `holdSpawns`).
 * - `delivery_lease` has one row per kind of delivery work (`events`,
 *   `transcripts`); see `lease.ts`.
 *
 * It all lives in queue.db rather than a side file so the hook reads and claims
 * it on the connection it already has open — a tool-lifecycle hook stays I/O-free.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events_queue (
  event_id        TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  attempted_at    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  enriched        INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS events_queue_ts_idx ON events_queue (ts);
CREATE TABLE IF NOT EXISTS drain_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  mode                TEXT NOT NULL DEFAULT 'resident',
  spawn_claimed_until INTEGER NOT NULL DEFAULT 0,
  last_drain_ok_at    INTEGER,
  rejected_token_hash TEXT,
  rejected_at         INTEGER,
  failure_streak      INTEGER NOT NULL DEFAULT 0,
  spawn_hold_until    INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS delivery_lease (
  kind       TEXT PRIMARY KEY CHECK (kind IN ('events', 'transcripts')),
  token      TEXT,
  pid        INTEGER,
  role       TEXT,
  started_at INTEGER,
  expires_at INTEGER NOT NULL DEFAULT 0
) STRICT;
`;

/** Bump when a table or column is added above. */
const SCHEMA_VERSION = 4;

/** Columns a queue.db created by an earlier version lacks. */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ['events_queue', 'next_attempt_at', 'TEXT'],
  ['events_queue', 'enriched', 'INTEGER NOT NULL DEFAULT 0'],
  ['drain_state', 'rejected_token_hash', 'TEXT'],
  ['drain_state', 'rejected_at', 'INTEGER'],
  ['drain_state', 'failure_streak', 'INTEGER NOT NULL DEFAULT 0'],
  ['drain_state', 'spawn_hold_until', 'INTEGER NOT NULL DEFAULT 0'],
];

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

/**
 * Create the schema and bring an older queue.db up to date.
 *
 * Every hook calls this, so the steady state is ONE `PRAGMA user_version` read and
 * no write of any kind. All DDL — including the CREATEs, which are not free of
 * the write lock even when they are no-ops — happens once per database inside an
 * IMMEDIATE transaction that re-checks the version, so two processes upgrading at
 * the same moment cannot both ALTER, and a hook meeting the one-time upgrade waits
 * on the lock instead of failing on a half-built schema.
 */
export function ensureSchema(db: Database): void {
  if (userVersion(db) >= SCHEMA_VERSION) {
    return;
  }
  db.transaction(() => {
    if (userVersion(db) >= SCHEMA_VERSION) {
      return;
    }
    db.exec(SCHEMA);
    for (const [table, column, type] of ADDED_COLUMNS) {
      const have = db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === column);
      if (!have) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
    db.exec('INSERT OR IGNORE INTO drain_state (id) VALUES (1)');
    db.exec("INSERT OR IGNORE INTO delivery_lease (kind) VALUES ('events'), ('transcripts')");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}
