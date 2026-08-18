-- P13-013 — the `scores` uniqueness rule, which Prisma cannot express.
--
-- The key gains `period_start` so a subject that persists (a skill, an MCP
-- server) accumulates one row per window instead of overwriting the same row
-- every night. Before this, `compute-subject-scores` could not produce the trend
-- its own docstring described: each run rewrote the previous run's figure.
--
-- **NULLS NOT DISTINCT is the load-bearing part.** A session's score is not
-- periodic, so its `period_start` is NULL — and under Postgres's default
-- semantics every NULL is distinct, meaning two rows for the same session would
-- both insert rather than conflicting. That would silently turn the idempotent
-- upsert every scorer job depends on into an append: re-running a job would
-- multiply its rows instead of refreshing them, and nothing would error.
--
-- Requires Postgres 15+. The stack runs 18.
--
-- This lives here rather than in `schema.prisma` for the same reason
-- `sessions_run_kind_idx` does: Prisma's schema language has no way to say it.
-- `packages/db/test/scores-period-key.test.ts` fails if this file stops
-- declaring it, because a silently-dropped constraint here is invisible until
-- duplicate scores appear.

-- Belt and braces. The Prisma migration alongside this one already drops the old
-- @@unique index, and a fresh install never creates it — the constraint is gone
-- from `schema.prisma`. These two lines only matter for a database that was
-- migrated before this change landed, where the old index would otherwise sit
-- alongside the new one and keep rejecting the second period for a subject.
ALTER TABLE "scores" DROP CONSTRAINT IF EXISTS
  "scores_subject_type_subject_id_scorer_name_scorer_version_key";
DROP INDEX IF EXISTS "scores_subject_type_subject_id_scorer_name_scorer_version_key";

CREATE UNIQUE INDEX IF NOT EXISTS scores_subject_scorer_period_key
  ON "scores" (subject_type, subject_id, scorer_name, scorer_version, period_start)
  NULLS NOT DISTINCT;
