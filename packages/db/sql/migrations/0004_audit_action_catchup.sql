-- Catch-up for `AuditAction` values that were added by editing the squashed
-- init migration after this schema had already shipped.
--
-- WHY THIS FILE EXISTS
--
-- The relational layer is a single squashed Prisma migration, and Prisma's
-- idempotency check is NAME-BASED. On a database that already recorded
-- `20260814000000_init`, editing that file is invisible: it never re-runs. The
-- documented recovery is a full reset, which is correct while nothing is
-- deployed and unacceptable once something is -- a reset wipes all telemetry.
--
-- Three enum values were nonetheless added by editing it, across two releases:
-- `HOOK_TOKEN_REVOKED` and `ADMIN_JOB_TRIGGERED` (#210), and
-- `ADMIN_JOB_CONFIG_CHANGED` (#239, shipped in v2.5.0). An upgrade runs
-- `migrations-runner`, which applies layer 1 by name and therefore skips them,
-- so an upgraded database is missing values the application writes.
--
-- The failure is silent, which is why it went unnoticed: `writeAuditLog` never
-- throws (it logs and returns false, and callers ignore the result), so a job
-- config change on an upgraded install persisted the change and wrote NO audit
-- row -- strictly worse than the row it replaced.
--
-- WHY EVERY VALUE, NOT JUST THE THREE
--
-- Listing the full enum makes this file self-correcting: it repairs a database
-- upgrading from ANY past release without anyone having to work out which
-- values that release predates. Every value already present is a no-op, so on a
-- fresh database -- where layer 1 created the type complete -- the whole file
-- does nothing. Only `AuditAction` is listed because it is the only enum whose
-- `CREATE TYPE` has been edited since the squash (verified against the history
-- of `migration.sql`, not assumed).
--
-- ORDER
--
-- Values are listed in schema order and appended, never reordered -- the same
-- rule `schema.prisma` states for `AgentType`. A missing value is appended at
-- the end, which matches where the init migration puts it for a fresh database.
--
-- TRANSACTION SAFETY
--
-- `applySqlMigrations()` wraps every file in one `$transaction`.
-- `ALTER TYPE ... ADD VALUE` inside a transaction block was an ERROR before
-- Postgres 12; 12+ permits it provided the new value is not USED in the same
-- transaction, which nothing here does. The stack runs `timescale/timescaledb`
-- on PG18, and this was verified against a real PG18 server rather than
-- inferred from the version: all three statements committed, and a second run
-- was a clean no-op.
--
-- If this file ever throws, `migrations-runner` exits non-zero and every
-- service gated on it refuses to start -- so it must stay unconditional and
-- idempotent. `IF NOT EXISTS` is what makes that true.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'VIEW_SESSION';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'VIEW_TRANSCRIPT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPORT_TEAM';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPORT_ORG';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_IMPERSONATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DELETE_REQUEST';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HOOK_TOKEN_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ROLE_GRANT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RETENTION_OVERRIDE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRANT_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRANT_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRANT_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ALERT_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ALERT_SILENCED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'JUDGE_READ_TRANSCRIPT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MODEL_POLICY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'HOOK_TOKEN_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_JOB_TRIGGERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_JOB_CONFIG_CHANGED';
