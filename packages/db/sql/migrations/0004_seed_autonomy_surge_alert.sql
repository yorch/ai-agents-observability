-- Seed the built-in autonomy-surge alert rule (R9, Human-in-the-loop governance):
-- fires when the share of sessions running with no per-action human gate
-- (bypass / dont_ask) over the recent window crosses the threshold — i.e. when
-- human oversight is eroding org-wide. Aggregate-only, like the other rules.
-- Same idempotent pattern as 0002 (uuid-keyed rows, no natural ON CONFLICT key).
INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
SELECT gen_random_uuid(), 'Autonomy surge (oversight erosion)', 'autonomy_surge', '{}', true, 60
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_rules" existing WHERE existing."rule_type" = 'autonomy_surge'
);
