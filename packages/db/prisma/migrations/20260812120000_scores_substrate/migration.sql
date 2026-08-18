-- P13-001: the scoring substrate.
--
-- Forward-only: a new migration rather than a patch to the squashed init, so an
-- already-deployed database picks this up without the reset dance described in
-- packages/db/AGENTS.md.

-- CreateEnum
CREATE TYPE "ScoreSubjectType" AS ENUM ('SESSION', 'PULL_REQUEST', 'SKILL', 'MCP_SERVER');

-- CreateEnum
CREATE TYPE "ScoreSource" AS ENUM ('HEURISTIC', 'DETERMINISTIC', 'HUMAN', 'JUDGE', 'OUTCOME');

-- CreateTable
CREATE TABLE "scores" (
    "id" UUID NOT NULL,
    "subject_type" "ScoreSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "scorer_name" TEXT NOT NULL,
    "scorer_version" INTEGER NOT NULL,
    "source" "ScoreSource" NOT NULL,
    "value" DOUBLE PRECISION,
    "label" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "rationale_ref" TEXT,
    "cost_usd" DECIMAL(12,6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scores_subject_type_subject_id_scorer_name_scorer_version_key"
    ON "scores"("subject_type", "subject_id", "scorer_name", "scorer_version");

-- CreateIndex
CREATE INDEX "scores_subject_type_subject_id_idx" ON "scores"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "scores_scorer_name_scorer_version_created_at_idx"
    ON "scores"("scorer_name", "scorer_version", "created_at" DESC);
