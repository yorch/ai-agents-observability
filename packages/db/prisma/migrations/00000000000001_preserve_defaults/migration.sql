-- Preserve column DEFAULT not represented in schema.prisma.
--
-- The pre-consolidation migration 20260522_job_run added `DEFAULT 'running'`
-- to job_runs.status as a hand-rolled SQL convenience. schema.prisma's
-- JobRun.status has no @default, so the regenerated init drops the default.
-- Restore it here so legacy callers that insert rows without specifying
-- `status` still get the 'running' sentinel.
ALTER TABLE "job_runs"
  ALTER COLUMN "status" SET DEFAULT 'running';
