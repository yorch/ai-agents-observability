-- Phase 9 (P9-003): time-boxed, scoped, audited access grants (DESIGN_DOC §8.4).

-- CreateEnum
CREATE TYPE "GrantScope" AS ENUM ('user_sessions', 'single_session');

-- New audit actions for the grant lifecycle.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'grant_requested';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'grant_approved';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'grant_revoked';

-- CreateTable
CREATE TABLE "access_grants" (
    "id" UUID NOT NULL,
    "grantee_user_id" UUID NOT NULL,
    "target_user_id" UUID,
    "target_session_id" UUID,
    "scope" "GrantScope" NOT NULL,
    "justification" TEXT NOT NULL,
    "granted_by_user_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_grants_grantee_user_id_expires_at_idx" ON "access_grants"("grantee_user_id", "expires_at");

-- CreateIndex
CREATE INDEX "access_grants_granted_at_revoked_at_idx" ON "access_grants"("granted_at", "revoked_at");

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_grantee_user_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
