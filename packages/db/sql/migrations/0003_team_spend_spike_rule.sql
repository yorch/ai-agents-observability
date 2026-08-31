-- 0003_team_spend_spike_rule.sql
--
-- Seeds the `team_spend_spike` alert rule (C2). Disabled by default, like the
-- other optional rules: an upgrade adds no noise until an admin enables it in
-- /admin/alerts. The rule has no configurable params — it uses the shared
-- statistical thresholds from packages/schemas/src/alerts.ts
-- (TEAM_SPEND_SPIKE_*). It fires when ANY team's 7-day spend exceeds 2.5σ
-- above its own 14-day baseline.
INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
SELECT gen_random_uuid(), 'Team spend spike', 'team_spend_spike', '{}'::jsonb, false, 60
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_rules" existing WHERE existing."rule_type" = 'team_spend_spike'
);
