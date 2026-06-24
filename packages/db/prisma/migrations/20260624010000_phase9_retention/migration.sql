-- Phase 9 (P9-004): per-team transcript retention override.

-- Per-team retention override. null = use the global TRANSCRIPT_RETENTION_DAYS.
ALTER TABLE "teams" ADD COLUMN "retention_days" INTEGER;

-- New audit action for team retention override changes. ADD VALUE is allowed
-- inside a migration transaction on PG12+ as long as the value isn't used in the
-- same transaction (it isn't — it's written by the app later).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'retention_override_changed';
