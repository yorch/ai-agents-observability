-- 0002_secret_exposure_rule.sql
--
-- Seeds the `secret_exposure` alert rule (S1). Disabled by default, like the
-- other built-in rules in 0001_init.sql's seed block: an upgrade adds no noise
-- until an admin enables and tunes it in /admin/alerts. The threshold is
-- overridable per-rule via params.threshold; the default lives in
-- packages/schemas/src/alerts.ts (SECRET_EXPOSURE_DEFAULT_THRESHOLD).
--
-- This is a forward-only numbered file rather than a fold into 0001_init.sql:
-- 0001 is closed (see packages/db/AGENTS.md), and a database that already
-- applied 0001 will pick this rule up through applySqlMigrations() on the next
-- boot, without a reset.
INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
SELECT gen_random_uuid(), 'Secret exposure surge', 'secret_exposure', '{"threshold": 5}'::jsonb, false, 60
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_rules" existing WHERE existing."rule_type" = 'secret_exposure'
);
