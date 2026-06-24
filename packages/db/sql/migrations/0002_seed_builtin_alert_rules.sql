-- Custom (non-Prisma) SQL: seed the built-in alert rules so alerting works out of
-- the box before any admin UI (P9-001). Applied by `applySqlMigrations()` after
-- `prisma migrate deploy`, tracked once in `_db_sql_migrations`. `rule_type` is a
-- plain TEXT column (not a DB enum), so these stay lowercase.
INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
VALUES
  (gen_random_uuid(), 'Org spend spike',        'spend_spike',         '{}', true, 60),
  (gen_random_uuid(), 'High tool error rate',   'high_error_rate',     '{}', true, 60),
  (gen_random_uuid(), 'Unknown-model surge',    'unknown_model_surge', '{}', true, 60);
