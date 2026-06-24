-- Custom (non-Prisma) SQL: seed the built-in alert rules so alerting works out of
-- the box before any admin UI (P9-001). Applied by `applySqlMigrations()` after
-- `prisma migrate deploy`, tracked once in `_db_sql_migrations`. `rule_type` is a
-- plain TEXT column (not a DB enum), so these stay lowercase.
-- Idempotent (`WHERE NOT EXISTS`): a re-apply against a non-pristine DB — e.g. a
-- truncated tracking table or a data-only restore — won't duplicate a rule
-- (rows are uuid-keyed, so there is no natural unique key to ON CONFLICT on).
INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
SELECT gen_random_uuid(), v.name, v.rule_type, '{}', true, 60
FROM (VALUES
  ('Org spend spike',      'spend_spike'),
  ('High tool error rate', 'high_error_rate'),
  ('Unknown-model surge',  'unknown_model_surge')
) AS v(name, rule_type)
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_rules" existing WHERE existing."rule_type" = v.rule_type
);
