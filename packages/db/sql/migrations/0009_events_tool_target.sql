-- P13-003: capture columns for the deterministic trajectory scorers.
--
-- `events` is a TimescaleDB hypertable and does not appear in schema.prisma, so
-- ALTER TABLE belongs in this layer (see packages/db/AGENTS.md). Applied once:
-- applySqlMigrations() (packages/db/src/sql-migrate.ts) tracks applied filenames
-- in `_db_sql_migrations` and skips files already recorded there — this file
-- runs a single time per environment, not on every boot. The `IF NOT EXISTS`
-- guards are belt-and-braces for a half-applied file, not because it re-runs.
--
-- Neither column carries content. `tool_target_hash` is a non-reversible digest
-- of *what* a call acted on (a path, a glob, a URL, a command), derived on the
-- developer's machine; `tool_action` is a five-way label over a shell command.
-- DESIGN_DOC §9.3's rule is that raw tool I/O is never stored server-side, and
-- neither of these is tool I/O: they are facts about the trajectory, which is
-- exactly what the deterministic scorers measure and the only thing they read.
--
-- Both are nullable and stay null for adapters that cannot derive them. The
-- scorers treat null as "not observable" and return null themselves rather than
-- inventing a number, so this migration is safe to apply ahead of any client
-- that populates the columns.

ALTER TABLE events ADD COLUMN IF NOT EXISTS tool_target_hash TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS tool_action      TEXT;

-- The scorers read a whole session's trajectory at once, which the existing
-- events_session_id_ts_idx already serves. The only new access pattern is
-- "sessions that ran a test command", narrow enough to earn a partial index.
CREATE INDEX IF NOT EXISTS events_tool_action_ts_idx
  ON events (tool_action, ts DESC)
  WHERE tool_action IS NOT NULL;
