-- P13-002: restrict the three continuous aggregates to INTERACTIVE runs.
--
-- This file is applied ONCE, tracked by filename in `_db_sql_migrations`
-- (see packages/db/src/sql-migrate.ts) — it does NOT re-run on later boots.
-- The IF NOT EXISTS / IF EXISTS guards below are belt-and-braces for a
-- half-applied file (a crash mid-transaction), not because this SQL runs
-- more than once in the ordinary case.
--
-- All three exist solely to power human-facing dashboards (org cost, model mix,
-- tool usage). CI and eval runs have no human prompts, so including them would
-- distort every per-developer figure those dashboards present — the concern
-- DESIGN_DOC §13 Q8 raises about CI-side runs.
--
-- The filter is baked into the aggregate definition rather than applied at the
-- ~12 read sites. That is deliberate: an aggregate named `daily_cost_by_user`
-- feeding a developer dashboard should not be able to contain non-human runs at
-- all, and a filter at the definition cannot be forgotten by a future reader the
-- way a per-call-site predicate can. Non-interactive volume is queried from the
-- raw `events` hypertable, which keeps its own `run_kind` column (0007).
--
-- Redefines in place (DROP + CREATE), mirroring 0005 and the 0001 cagg pattern:
-- WITH NO DATA plus a continuous-aggregate policy. No in-migration refresh — that
-- cannot run inside the migration transaction; the policy materializes hourly and
-- real-time aggregation covers the tail until it does.
--
-- Column sets are otherwise unchanged from 0001/0005, so every existing read
-- keeps working with no query change.
--
-- *** WARNING — data-visibility regression for `daily_cost_by_user` ***
--
-- Unlike `daily_cost_by_model` and `daily_tool_usage` (genuinely unused by
-- application code before this change, per 0005's precedent), `daily_cost_by_user`
-- IS read by application code today: apps/web/src/lib/org-queries.ts (cost-by-team,
-- cost-by-user, and the org cost trend). `DROP ... CASCADE` destroys the
-- previously-materialized buckets for this view, and the recreated view is
-- `WITH NO DATA` with a policy `start_offset => INTERVAL '32 days'`. Real-time
-- aggregation covers the tail (data newer than the last materialization run), but
-- once the continuous-aggregate policy's background worker has advanced its
-- watermark, buckets OLDER than 32 days are covered by neither the materialized
-- data (dropped, never re-backfilled by the policy — it only ever materializes the
-- rolling 32-day window going forward) nor real-time aggregation (which only
-- covers the region above the watermark). Confirmed against a live TimescaleDB
-- instance: after the watermark advances, `SELECT count(*) FROM
-- daily_cost_by_user WHERE day < now() - interval '32 days'` returns 0 even
-- though the underlying `events` rows are still present — org cost history older
-- than 32 days silently disappears from every reader of this view, with no error.
--
-- `refresh_continuous_aggregate()` cannot run inside a transaction block, and
-- every file in this directory is applied inside one (`sql-migrate.ts` wraps the
-- whole file in `prisma.$transaction`), so the backfill CANNOT be folded into
-- this migration — attempting to `CALL refresh_continuous_aggregate(...)` here
-- would fail the deploy outright. It must be run manually, once, immediately
-- after this migration is deployed, by an operator with direct DB access:
--
--   CALL refresh_continuous_aggregate('daily_cost_by_user', NULL, NULL);
--
-- Passing NULL for both the start and end window re-materializes the view's
-- entire history from the raw `events` hypertable, closing the gap this
-- migration opens. See docs/runbooks/cagg-cost-history-gap.md for the full
-- operator procedure (verifying the gap, running the refresh, confirming it
-- closed). Do not run this command as part of applying this migration file —
-- it is documented here, not executed here, precisely because it cannot be.
--
-- Alternative considered and rejected: keeping the existing materialized data by
-- adding the `run_kind = 'INTERACTIVE'` filter without a DROP. TimescaleDB has no
-- ALTER for a continuous aggregate's underlying query — the materialized data
-- lives in a hidden hypertable tied 1:1 to the view definition, so changing the
-- SELECT (which this migration must do, to add the WHERE clause) requires drop +
-- recreate. There is no in-place path here; the manual refresh above is the
-- mitigation, not a workaround to avoid needing one.

DROP MATERIALIZED VIEW IF EXISTS daily_cost_by_user CASCADE;

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
WHERE run_kind = 'INTERACTIVE'
GROUP BY 1, 2, 3
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_cost_by_user',
  start_offset => INTERVAL '32 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

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
  AND run_kind = 'INTERACTIVE'
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
  AND run_kind = 'INTERACTIVE'
GROUP BY 1, 2, 3, 4, 5
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_tool_usage',
  start_offset => INTERVAL '32 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);
