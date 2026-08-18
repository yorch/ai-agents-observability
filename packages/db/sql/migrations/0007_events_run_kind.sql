-- P13-002: run_kind on the events hypertable.
--
-- `events` is a TimescaleDB hypertable and is not Prisma-managed, so the column is
-- added here rather than through a Prisma migration (same reasoning as 0003).
-- Applied once: `applySqlMigrations()` (packages/db/src/sql-migrate.ts) tracks
-- applied filenames in `_db_sql_migrations` and skips files already recorded
-- there, so this file runs a single time per environment, not on every boot.
-- The `IF NOT EXISTS` guards are belt-and-braces for a half-applied file (a
-- crash mid-transaction), not because this SQL is expected to run twice.

ALTER TABLE events ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'INTERACTIVE';

-- Partial index for the same reason as the sessions one: only the exceptions are
-- worth indexing, since every human-facing read filters to INTERACTIVE.
CREATE INDEX IF NOT EXISTS events_run_kind_idx
  ON events (run_kind, ts DESC)
  WHERE run_kind <> 'INTERACTIVE';
