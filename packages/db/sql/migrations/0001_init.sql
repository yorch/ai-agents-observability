-- TimescaleDB-specific DDL applied after prisma migrate deploy.
-- Prisma cannot model hypertables, continuous aggregates, compression policies,
-- or GENERATED ALWAYS AS (tsvector) columns, so they live here.

-- ── Events firehose ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  event_id              UUID NOT NULL,
  session_id            UUID NOT NULL,
  user_id               UUID NOT NULL,
  ts                    TIMESTAMPTZ NOT NULL,

  agent_type            TEXT NOT NULL DEFAULT 'claude_code',

  event_type            TEXT NOT NULL,
  turn_number           INT,
  parent_event_id       UUID,

  tool_name             TEXT,
  tool_category         TEXT,
  tool_input_hash       TEXT,
  tool_input_bytes      INT,
  tool_output_bytes     INT,
  tool_duration_ms      INT,
  tool_exit_status      INT,
  tool_was_denied       BOOLEAN,
  tool_was_interrupted  BOOLEAN,

  mcp_server            TEXT,
  mcp_tool              TEXT,

  subagent_type         TEXT,

  skill_name            TEXT,
  skill_path            TEXT,

  slash_command         TEXT,

  model                 TEXT,
  input_tokens          INT,
  output_tokens         INT,
  cache_read_tokens     INT,
  cache_creation_tokens INT,
  cost_usd              NUMERIC(12, 6),

  mode                  TEXT,

  metadata              JSONB,

  PRIMARY KEY (session_id, event_id, ts)
);

SELECT create_hypertable('events', 'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_key      ON events (event_id, ts);
CREATE INDEX IF NOT EXISTS events_user_id_ts_idx           ON events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_session_id_ts_idx        ON events (session_id, ts);
CREATE INDEX IF NOT EXISTS events_tool_name_ts_idx         ON events (tool_name, ts DESC) WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_mcp_server_ts_idx        ON events (mcp_server, ts DESC) WHERE mcp_server IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_skill_name_ts_idx        ON events (skill_name, ts DESC) WHERE skill_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_agent_type_ts_idx        ON events (agent_type, ts DESC);

ALTER TABLE events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, session_id',
  timescaledb.compress_orderby   = 'ts DESC'
);

SELECT add_compression_policy('events', INTERVAL '7 days', if_not_exists => TRUE);

-- ── Continuous aggregates (org-level dashboards) ──────────────────────────────

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

-- ── Transcript full-text search ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transcript_index (
  session_id      UUID NOT NULL,
  message_idx     INT NOT NULL,
  role            TEXT NOT NULL,
  ts              TIMESTAMPTZ,
  content_text    TEXT NOT NULL,
  content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content_text)) STORED,
  PRIMARY KEY (session_id, message_idx),
  CONSTRAINT transcript_index_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS transcript_index_tsv_idx
  ON transcript_index USING GIN (content_tsv);

CREATE INDEX IF NOT EXISTS transcript_index_session_idx
  ON transcript_index (session_id);
