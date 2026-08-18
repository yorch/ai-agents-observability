-- P13-005 (session label rubric) + P13-006 (projection registry).
--
-- Forward-only: a new migration rather than a patch to the squashed init, so an
-- already-deployed database picks this up without the reset dance described in
-- packages/db/AGENTS.md.
--
-- Non-destructive by construction. Existing session_feedback rows are neither
-- rewritten nor invalidated: the three new columns are nullable or defaulted,
-- and rubric_version defaults to 0, which is exactly how a pre-rubric row should
-- read (see packages/schemas/src/rubric.ts — PRE_RUBRIC_VERSION).

-- AlterTable: session_feedback gains the versioned rubric.
ALTER TABLE "session_feedback" ADD COLUMN "rubric_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "session_feedback" ADD COLUMN "shape_label" TEXT;
ALTER TABLE "session_feedback" ADD COLUMN "task_outcome" TEXT;

-- Sentiment becomes optional: "how did this feel" and "did it work" are distinct
-- signals, so a rubric answer with no thumbs is a legitimate row. Dropping NOT
-- NULL never invalidates an existing value.
ALTER TABLE "session_feedback" ALTER COLUMN "sentiment" DROP NOT NULL;

-- CreateTable: the projection registry.
CREATE TABLE "projections" (
    "id" UUID NOT NULL,
    "claim_type" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "projected_low" DOUBLE PRECISION NOT NULL,
    "projected_high" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "baseline_value" DOUBLE PRECISION NOT NULL,
    "baseline_window_days" INTEGER NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "price_table_version" TEXT,
    "scorer_versions" JSONB NOT NULL DEFAULT '{}',
    "guard_baseline" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projections_claim_type_segment_period_start_key"
    ON "projections"("claim_type", "segment", "period_start");

-- CreateIndex
CREATE INDEX "projections_claim_type_period_start_idx"
    ON "projections"("claim_type", "period_start" DESC);
