-- P13-002: run_kind dimension on sessions.
--
-- `events` carries the same column, but it is a TimescaleDB hypertable and does
-- not appear in schema.prisma, so its ALTER lives in sql/migrations/ (see
-- packages/db/AGENTS.md — "nothing Prisma could have modelled").

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('INTERACTIVE', 'CI', 'EVAL');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "run_kind" "RunKind" NOT NULL DEFAULT 'INTERACTIVE';

-- CreateIndex
-- Partial: every human-facing aggregate filters to INTERACTIVE, and non-interactive
-- rows are expected to stay a small minority, so indexing only the exceptions keeps
-- the index tiny while still letting the planner find them.
CREATE INDEX "sessions_run_kind_idx" ON "sessions"("run_kind") WHERE "run_kind" <> 'INTERACTIVE';
