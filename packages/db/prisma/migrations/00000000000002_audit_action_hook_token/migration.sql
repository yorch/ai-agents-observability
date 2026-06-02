-- Add 'hook_token_issued' to the AuditAction enum so device-code hook-token
-- issuance is recorded with its own action instead of a misleading 'view_session'
-- placeholder (which polluted the user's "who looked at me" audit feed).
--
-- PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as long as
-- the new value is not USED in the same transaction (it isn't here). Idempotent
-- via IF NOT EXISTS so re-running the runner is safe.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'hook_token_issued';
