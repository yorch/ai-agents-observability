-- Seed the built-in model-governance alert rule (P10-005): fires when spend over
-- the recent window went to models outside the org's allow-list for their
-- agent_type. "Allowed" is the P10-002 `model_policy` table — the evaluator joins
-- against it rather than carrying a second definition. Aggregate-only detail.
--
-- Seeded DISABLED, and it would be inert even if enabled: an agent with no
-- model_policy row (or one with an empty allowed_models) contributes zero
-- disallowed spend, because an unconfigured allow-list means "unconfigured", not
-- "deny everything". Seeding it disabled means an upgrade adds no noise — an admin
-- fills in the allow-list in /admin/model-policy, then enables and tunes
-- params.thresholdUsd in /admin/alerts. Same idempotent pattern as 0002/0006.
INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
SELECT gen_random_uuid(), 'Disallowed model spend', 'disallowed_model',
       '{"thresholdUsd": 10}', false, 60
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_rules" existing WHERE existing."rule_type" = 'disallowed_model'
);
