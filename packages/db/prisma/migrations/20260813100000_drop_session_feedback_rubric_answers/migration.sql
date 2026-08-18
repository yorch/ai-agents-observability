-- P13-005 follow-up: the rubric answers stop being written in two places.
--
-- `20260812140000_session_rubric_and_projections` added `shape_label` and
-- `task_outcome` to `session_feedback` at the same time as the same two answers
-- began being written to `scores` (`human_session_shape` / `human_task_outcome`,
-- source HUMAN, rubric version as scorer_version). Two stores for one fact, in
-- two separate awaits: a failure between them left the developer's label in one
-- and not the other, and P13-007's calibration reads `scores` — the one that
-- loses. `scores` is the substrate every other scorer already writes to, so the
-- duplicate columns go rather than the score rows.
--
-- `rubric_version` stays. It is not duplicated anywhere: an absent score row
-- cannot distinguish "answered version 1 and declined both questions" from
-- "predates the rubric", and only the first says anything about the rubric.
--
-- Forward-only: a new migration rather than a patch to the one above, so an
-- already-deployed database picks this up without the reset dance in
-- packages/db/AGENTS.md.
--
-- Data note: this is the destructive kind of forward migration, so it copies
-- before it drops. Any answer that reached `session_feedback` but not `scores`
-- (exactly the divergence this removes) is written across first; rows that
-- already agree are left alone by the ON CONFLICT, and pre-rubric rows
-- (rubric_version = 0) are skipped because their NULL answers say nothing.

INSERT INTO "scores" (
  "id", "subject_type", "subject_id", "scorer_name", "scorer_version",
  "source", "label", "metadata", "created_at"
)
SELECT
  gen_random_uuid(),
  'SESSION'::"ScoreSubjectType",
  f."session_id"::text,
  v."scorer_name",
  f."rubric_version",
  'HUMAN'::"ScoreSource",
  v."label",
  '{}'::jsonb,
  f."updated_at"
FROM "session_feedback" f
CROSS JOIN LATERAL (
  VALUES
    ('human_session_shape', f."shape_label"),
    ('human_task_outcome',  f."task_outcome")
) AS v("scorer_name", "label")
WHERE f."rubric_version" > 0
  AND v."label" IS NOT NULL
ON CONFLICT ("subject_type", "subject_id", "scorer_name", "scorer_version") DO NOTHING;

-- AlterTable
ALTER TABLE "session_feedback" DROP COLUMN "shape_label";
ALTER TABLE "session_feedback" DROP COLUMN "task_outcome";
