-- Events firehose — TimescaleDB hypertable
-- Applied by the migrations runner after prisma migrate deploy.
-- Prisma is intentionally unaware of this table (no model, hypertable support
-- was removed from Prisma preview features).

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

CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_key ON events (event_id);

CREATE INDEX IF NOT EXISTS events_user_id_ts_idx      ON events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_session_id_ts_idx   ON events (session_id, ts);
CREATE INDEX IF NOT EXISTS events_tool_name_ts_idx    ON events (tool_name, ts DESC) WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_mcp_server_ts_idx   ON events (mcp_server, ts DESC) WHERE mcp_server IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_skill_name_ts_idx   ON events (skill_name, ts DESC) WHERE skill_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_agent_type_ts_idx   ON events (agent_type, ts DESC);

ALTER TABLE events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, session_id',
  timescaledb.compress_orderby   = 'ts DESC'
);

SELECT add_compression_policy('events', INTERVAL '7 days', if_not_exists => TRUE);

-- Retention policy: indefinite for now; add via Phase 4 only if storage pressure surfaces.
-- SELECT add_retention_policy('events', INTERVAL '1 year', if_not_exists => TRUE);
