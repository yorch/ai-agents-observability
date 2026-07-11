-- Add a `user_id` dimension to the model + tool continuous aggregates so org
-- views can visibility-scope them (filter to org-metadata sharers) exactly like
-- the raw-events queries do. As shipped in 0001 these two aggregates keyed only
-- on (day, model|tool, agent_type), so a WHERE user_id IN (...) filter was
-- impossible and the web had to scan the raw `events` hypertable instead.
--
-- Redefines both aggregates in place (DROP + CREATE, mirroring the 0001 cagg
-- pattern: WITH NO DATA + a continuous-aggregate policy; no in-migration refresh,
-- which cannot run inside the migration transaction — the policy materializes
-- hourly and real-time aggregation covers the tail). The `distinct_users` column
-- is dropped (meaningless once user_id is a group key); `daily_cost_by_model`
-- gains `total_cache_creation` + `session_count` so it can fully serve the org
-- model-detail view. Both aggregates were previously unused by application code,
-- so nothing depends on the old column set.

DROP MATERIALIZED VIEW IF EXISTS daily_cost_by_model CASCADE;

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_cost_by_model
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 day', ts)       AS day,
  user_id,
  model,
  agent_type,
  SUM(cost_usd)                  AS total_cost_usd,
  SUM(input_tokens)              AS total_input_tokens,
  SUM(output_tokens)             AS total_output_tokens,
  SUM(cache_read_tokens)         AS total_cache_read,
  SUM(cache_creation_tokens)     AS total_cache_creation,
  COUNT(*)                       AS event_count,
  COUNT(DISTINCT session_id)     AS session_count
FROM events
WHERE model IS NOT NULL
GROUP BY 1, 2, 3, 4
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_cost_by_model',
  start_offset => INTERVAL '32 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

DROP MATERIALIZED VIEW IF EXISTS daily_tool_usage CASCADE;

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_tool_usage
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 day', ts)       AS day,
  user_id,
  tool_name,
  tool_category,
  agent_type,
  COUNT(*)                       AS call_count,
  COUNT(*) FILTER (WHERE tool_was_denied = true)  AS deny_count,
  AVG(tool_duration_ms)          AS avg_duration_ms
FROM events
WHERE event_type = 'PostToolUse'
  AND tool_name IS NOT NULL
GROUP BY 1, 2, 3, 4, 5
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_tool_usage',
  start_offset => INTERVAL '32 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);
