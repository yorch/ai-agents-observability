-- P13-009 (LLM-as-judge runner + guardrails).
--
-- Forward-only: a new migration rather than a patch to the squashed init, so an
-- already-deployed database picks this up without the reset dance described in
-- packages/db/AGENTS.md.
--
-- Two additions, both non-destructive:
--
-- 1. A new AuditAction value. The judge is a privileged reader of transcripts,
--    so every read it performs writes an audit row visible to the subject —
--    DESIGN_DOC.md §8.3, applied to a machine reader rather than a human one.
--    Adding an enum value is safe inside a transaction on PostgreSQL 12+ as
--    long as the new value is not *used* in the same transaction; nothing below
--    writes a row.
--
-- 2. An explicit per-user consent flag for judge analysis, defaulting to false.
--    Not a reuse of share_transcripts_with_org: "my org admin may read this"
--    and "a model may grade this" are separate consents, and deriving the
--    second from the first would grant it silently to everyone who ever ticked
--    the first. Existing rows land on false, which is the only safe default.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'JUDGE_READ_TRANSCRIPT';

-- AlterTable
ALTER TABLE "visibility_policies"
  ADD COLUMN "allow_judge_analysis" BOOLEAN NOT NULL DEFAULT false;
