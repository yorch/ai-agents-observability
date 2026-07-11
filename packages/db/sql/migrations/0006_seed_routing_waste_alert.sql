-- Seed the built-in routing-waste alert rule: fires when premium (Opus-class)
-- model spend on retrieval-only tool categories (fs_read / search) over the
-- recent window exceeds a threshold — the same money the /org/models routing
-- recommendation flags, promoted to a proactive alert. Aggregate-only.
--
-- Seeded DISABLED: the threshold is an absolute dollar amount and so org-size
-- dependent, so admins opt in and tune params.thresholdUsd in /admin/alerts
-- rather than getting a possibly-noisy default. Same idempotent pattern as 0002.
INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
SELECT gen_random_uuid(), 'Routing waste (premium models on retrieval)', 'routing_waste',
       '{"thresholdUsd": 25}', false, 60
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_rules" existing WHERE existing."rule_type" = 'routing_waste'
);
