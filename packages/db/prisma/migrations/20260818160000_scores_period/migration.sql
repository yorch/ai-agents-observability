-- DropIndex
DROP INDEX "scores_subject_type_subject_id_scorer_name_scorer_version_key";

-- AlterTable
ALTER TABLE "scores" ADD COLUMN     "period_end" TIMESTAMPTZ(6),
ADD COLUMN     "period_start" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "scores_subject_type_subject_id_scorer_name_period_start_idx" ON "scores"("subject_type", "subject_id", "scorer_name", "period_start" DESC);

