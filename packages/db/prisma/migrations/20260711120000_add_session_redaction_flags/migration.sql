-- Persist the redaction classes detected in each transcript at ship time.
-- Previously computed + logged in apps/ingest but never stored, so no per-class
-- secret-exposure report was possible. text[] default empty; backfilled only for
-- transcripts shipped after this migration.
ALTER TABLE "sessions" ADD COLUMN "redaction_flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
