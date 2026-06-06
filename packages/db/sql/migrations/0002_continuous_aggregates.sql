-- Phase 4: Timescale continuous aggregates for org-level dashboards.
-- These power the /org/dashboard queries without hitting raw events rows.

-- Daily cost / token breakdown by user
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_cost_by_user
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 day', ts)       AS day,
  user_id,
  agent_type,
  SUM(cost_usd)                  AS total_cost_usd,
  SUM(input_tokens)              AS total_input_tokens,
  SUM(output_tokens)             AS total_output_tokens,
  SUM(cache_read_tokens)         AS total_cache_read,
  COUNT(*) FILTER (WHERE event_type = 'PostToolUse')  AS tool_calls,
  COUNT(*) FILTER (WHERE tool_was_denied = true)      AS tool_denials,
  COUNT(DISTINCT session_id)     AS session_count
FROM events
GROUP BY 1, 2, 3
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_cost_by_user',
  start_offset => INTERVAL '32 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- Daily cost by model (for model-mix org charts)
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_cost_by_model
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 day', ts)       AS day,
  model,
  agent_type,
  SUM(cost_usd)                  AS total_cost_usd,
  SUM(input_tokens)              AS total_input_tokens,
  SUM(output_tokens)             AS total_output_tokens,
  SUM(cache_read_tokens)         AS total_cache_read,
  COUNT(*)                       AS event_count,
  COUNT(DISTINCT user_id)        AS distinct_users
FROM events
WHERE model IS NOT NULL
GROUP BY 1, 2, 3
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_cost_by_model',
  start_offset => INTERVAL '32 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- Daily tool usage (for org-wide top-tools)
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_tool_usage
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 day', ts)       AS day,
  tool_name,
  tool_category,
  agent_type,
  COUNT(*)                       AS call_count,
  COUNT(*) FILTER (WHERE tool_was_denied = true)  AS deny_count,
  AVG(tool_duration_ms)          AS avg_duration_ms,
  COUNT(DISTINCT user_id)        AS distinct_users
FROM events
WHERE event_type = 'PostToolUse'
  AND tool_name IS NOT NULL
GROUP BY 1, 2, 3, 4
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_tool_usage',
  start_offset => INTERVAL '32 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);
