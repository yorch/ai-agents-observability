-- Human-in-the-loop signal: classify Notification events on the firehose.
-- The `events` table is a TimescaleDB hypertable (Prisma cannot model it), so
-- this column lives in the custom SQL layer alongside the table itself (0001),
-- not in the Prisma schema. Idempotent ADD COLUMN so re-apply is safe.
--
-- `notification_kind` is the normalized classification of a Notification event
-- (permission | idle | elicitation | auth | other), computed client-side by the
-- hook and persisted by ingest. It powers "how often does the agent block on a
-- human, and for what?" without re-parsing the raw metadata blob.
ALTER TABLE events ADD COLUMN IF NOT EXISTS notification_kind TEXT;

-- Partial index: notification analytics scan only the Notification rows.
CREATE INDEX IF NOT EXISTS events_notification_kind_ts_idx
  ON events (notification_kind, ts DESC)
  WHERE notification_kind IS NOT NULL;
