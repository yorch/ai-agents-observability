-- TimescaleDB-specific DDL applied after `prisma migrate deploy`.
--
-- Prisma cannot model hypertables, continuous aggregates, compression policies,
-- or GENERATED ALWAYS AS (tsvector) columns, so they live here. Everything Prisma
-- *can* model lives in the single generated migration under `prisma/migrations/`
-- — see packages/db/AGENTS.md for the two-layer split.
--
-- This file is applied ONCE, tracked by filename in `_db_sql_migrations`
-- (packages/db/src/sql-migrate.ts). It does not re-run on later boots. The
-- IF NOT EXISTS guards are belt-and-braces for a half-applied file (a crash
-- mid-transaction), not because the file is expected to run twice.
--
-- Squashed 2026-08-26, pre-deployment, folding `0003_tool_cost_attribution.sql`
-- (P14-004) and `0004_live_turn_linkage.sql` (P14-006) back in: their three
-- `ALTER TABLE events ADD COLUMN`s are now columns of the `CREATE TABLE` below,
-- their `COMMENT ON COLUMN`s and the partial `events_session_tool_use_id_idx`
-- came with them, and their `CREATE OR REPLACE VIEW interactive_events` was
-- dropped — that statement existed only because the columns arrived *after* the
-- view, and the view at the bottom of this file now creates with them already in
-- place. `0002_tool_category_backfill.sql` was deleted rather than folded: it was
-- a pure `UPDATE` over rows ingested before P14-002, and a database created from
-- this file has no such rows.
--
-- Squashed 2026-08-14, pre-deployment, from nine incremental files. The previous
-- chain created the three continuous aggregates and then dropped and recreated
-- them twice more in the same deploy (0001 → 0005 → 0008). That was slow, it
-- destroyed materialized history that only a manual `refresh_continuous_aggregate`
-- could rebuild, and it intermittently failed the deploy outright with
-- `tuple concurrently deleted` when Timescale's background workers raced the
-- second rebuild. Defining each aggregate once, already filtered, removes all
-- three problems. Keep it that way: add a new numbered file for a change rather
-- than re-dropping anything here.

-- ── Events firehose ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  event_id              UUID NOT NULL,
  session_id            UUID NOT NULL,
  user_id               UUID NOT NULL,
  ts                    TIMESTAMPTZ NOT NULL,

  agent_type            TEXT NOT NULL DEFAULT 'CLAUDE_CODE',

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
  -- The host agent's own identifier for one tool call (P14-006). Opaque, and
  -- only ever compared within a single session_id — see the COMMENT below.
  tool_use_id           TEXT,

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

  -- Turn-linked cost attribution (P14-004). Real spend accrues per assistant
  -- turn — the `Stop` carries the model and the token counts, the tool rows
  -- carry none — so every "cost by tool / skill / sub-agent" number has to be
  -- *redistributed* from the turn onto the calls that turn made. These two are
  -- two lenses on the same dollars and are **NOT additive**: never sum them
  -- together, and never let either feed `sessions.total_cost_usd`,
  -- `pr_rollups.total_cost_usd`, or the three continuous aggregates below —
  -- that chain already counts these dollars exactly once, at the Stop event
  -- (see the header of `apps/ingest/src/jobs/reprice-events.ts`).
  --
  -- Both nullable with no default: NULL means "not attributed" — the turn
  -- linkage is absent, or the issuing turn's model had no price row. It never
  -- means "$0.00 of cost".
  attributed_cost_usd   NUMERIC(12, 6),
  downstream_cost_usd   NUMERIC(12, 6),

  mode                  TEXT,
  -- Why the agent interrupted the human (permission / idle / elicitation / auth).
  notification_kind     TEXT,
  -- How the run was produced. INTERACTIVE is the default so a client that never
  -- reports it is treated as a developer session; CI and EVAL runs are stored in
  -- full but never reach a human-facing aggregate.
  run_kind              TEXT NOT NULL DEFAULT 'INTERACTIVE',
  -- Content-free capture: a non-reversible digest of what a call acted on, and a
  -- coarse class for shell commands. Never the tool input, never the output.
  tool_target_hash      TEXT,
  tool_action           TEXT,

  metadata              JSONB,

  PRIMARY KEY (session_id, event_id, ts)
);

SELECT create_hypertable('events', 'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- Column comments carrying invariants a reader of `\d events` would otherwise
-- have to find in a task file.

COMMENT ON COLUMN events.attributed_cost_usd IS
  'P14-004: the issuing turn''s cost_usd divided evenly across the PostToolUse events that turn issued. NULL = not attributed. Not additive with downstream_cost_usd, and never rolled into sessions.total_cost_usd.';
COMMENT ON COLUMN events.downstream_cost_usd IS
  'P14-004: the following turn''s input-side cost apportioned to this tool call by tool_output_bytes. An approximation — bytes proxy for tokens. NULL = not attributed. Not additive with attributed_cost_usd.';
COMMENT ON COLUMN events.tool_use_id IS
  'P14-006: the host agent''s own identifier for one tool call (Claude Code''s tool_use_id, toolu_...). The natural key the link-turn-events job joins live tool events to transcript-derived turn linkage on, within a single session_id. Opaque — never parsed. NULL for non-tool events and for agents that supply no per-call id.';

CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_key      ON events (event_id, ts);
CREATE INDEX IF NOT EXISTS events_user_id_ts_idx           ON events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_session_id_ts_idx        ON events (session_id, ts);
CREATE INDEX IF NOT EXISTS events_tool_name_ts_idx         ON events (tool_name, ts DESC) WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_mcp_server_ts_idx        ON events (mcp_server, ts DESC) WHERE mcp_server IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_skill_name_ts_idx        ON events (skill_name, ts DESC) WHERE skill_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_agent_type_ts_idx        ON events (agent_type, ts DESC);

CREATE INDEX IF NOT EXISTS events_notification_kind_ts_idx
  ON events (notification_kind, ts DESC)
  WHERE notification_kind IS NOT NULL;

-- Partial: every human-facing read filters to INTERACTIVE, and non-interactive
-- rows are expected to stay a small minority, so only the exceptions are indexed.
CREATE INDEX IF NOT EXISTS events_run_kind_idx
  ON events (run_kind, ts DESC)
  WHERE run_kind <> 'INTERACTIVE';

CREATE INDEX IF NOT EXISTS events_tool_action_ts_idx
  ON events (tool_action, ts DESC)
  WHERE tool_action IS NOT NULL;

-- The linkage job (`apps/ingest/src/jobs/link-turn-events.ts`) looks up a batch
-- of sessions' unlinked tool rows by `(session_id, tool_use_id)`;
-- `events_session_id_ts_idx` gets it to the session, and without this it then
-- scans every event in that session. Partial because the column is NULL on every
-- non-tool event and on every agent that has not adopted the key — today six of
-- the seven — so a full index would be mostly dead entries on the largest table
-- in the schema. The predicate is one the job's own WHERE clause states, so the
-- planner can use it.
--
-- The two attribution columns above deliberately get **no** index: every read of
-- them is a `SUM()` bolted onto a scan the tool / MCP / skill / sub-agent
-- indexes above already serve, and the attribution job joins its results back by
-- `(event_id, ts)`, which `events_event_id_key` covers. Add one when a query
-- plan says so, not before.
CREATE INDEX IF NOT EXISTS events_session_tool_use_id_idx
  ON events (session_id, tool_use_id)
  WHERE tool_use_id IS NOT NULL;

ALTER TABLE events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, session_id',
  timescaledb.compress_orderby   = 'ts DESC'
);

SELECT add_compression_policy('events', INTERVAL '7 days', if_not_exists => TRUE);

-- ── Continuous aggregates (org-level dashboards) ─────────────────────────────
--
-- Defined ONCE, already filtered to INTERACTIVE runs. An aggregate named
-- `daily_cost_by_user` that feeds a developer dashboard should not be able to
-- contain non-human runs at all, and a filter in the definition cannot be
-- forgotten by a future reader the way a per-call-site predicate can.

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

-- ── Constraint Prisma cannot express ─────────────────────────────────────────
--
-- `sessions.redaction_flags` is a Prisma scalar list. Prisma treats those as
-- non-nullable in its own model but emits a plain nullable array column, so the
-- NOT NULL has to be added here or it is silently lost. It was present before the
-- migrations were squashed; this keeps it, rather than letting a mechanical
-- consolidation relax a constraint nobody asked to relax.

ALTER TABLE sessions ALTER COLUMN redaction_flags SET NOT NULL;

-- ── Partial index Prisma cannot express ──────────────────────────────────────
--
-- `sessions.run_kind` is Prisma-managed, but a *partial* index is not something
-- the Prisma schema can describe, so it lives in this layer rather than being
-- hand-patched into the generated migration. Partial for the same reason as the
-- events one: every human-facing read filters to INTERACTIVE, and non-interactive
-- rows are expected to stay a small minority, so indexing only the exceptions
-- keeps the index tiny while still letting the planner find them.

CREATE INDEX IF NOT EXISTS sessions_run_kind_idx
  ON sessions (run_kind)
  WHERE run_kind <> 'INTERACTIVE';

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

-- ── Built-in alert rules ──────────────────────────────────────────────────────
--
-- Seeded once, by rule_type, so an operator who disables or renames one does not
-- get it silently resurrected on the next boot.

INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
SELECT gen_random_uuid(), v.name, v.rule_type, '{}', true, 60
FROM (VALUES
  ('Org spend spike',      'spend_spike'),
  ('High tool error rate', 'high_error_rate'),
  ('Unknown-model surge',  'unknown_model_surge'),
  ('Autonomy surge (oversight erosion)', 'autonomy_surge')
) AS v(name, rule_type)
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_rules" existing WHERE existing."rule_type" = v.rule_type
);

-- Disabled by default: each needs something an operator chooses before it means
-- anything — a threshold, or in `disallowed_model`'s case an allow-list.
--
-- `disallowed_model` (P10-005) would be inert even if enabled: it joins
-- `model_policy` (P10-002), and an agent with no row — or one with an empty
-- `allowed_models` — contributes zero disallowed spend, because an unconfigured
-- allow-list means "unconfigured", not "deny everything". Seeding it disabled
-- means an upgrade adds no noise: an admin fills the allow-list in
-- /admin/model-policy, then enables and tunes it in /admin/alerts.
INSERT INTO "alert_rules" ("id", "name", "rule_type", "params", "enabled", "cadence_minutes")
SELECT gen_random_uuid(), v.name, v.rule_type, v.params::jsonb, false, 60
FROM (VALUES
  ('Org budget threshold', 'budget_threshold', '{}'),
  ('Routing waste (premium models on retrieval)', 'routing_waste', '{"thresholdUsd": 25}'),
  ('Disallowed model spend', 'disallowed_model', '{"thresholdUsd": 10}')
) AS v(name, rule_type, params)
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_rules" existing WHERE existing."rule_type" = v.rule_type
);


-- ─────────────────────────────────────────────────────────────────────────────
-- The `scores` uniqueness rule (P13-013), which Prisma cannot express.
--
-- The key carries `period_start` so a subject that persists — a skill, an MCP
-- server — accumulates one row per window instead of overwriting the same row
-- every night. Without it `compute-subject-scores` could not produce the trend
-- its own docstring describes: each run rewrote the previous run's figure.
--
-- **NULLS NOT DISTINCT is the load-bearing part.** A session's score is not
-- periodic, so its `period_start` is NULL — and under Postgres's default
-- semantics every NULL is distinct, meaning two rows for the same session would
-- both insert rather than conflicting. That would silently turn the idempotent
-- upsert every scorer job depends on into an append: re-running a job would
-- multiply its rows instead of refreshing them, and nothing would error.
--
-- Requires Postgres 15+. The stack runs 18.
--
-- It lives here rather than in `schema.prisma` for the same reason
-- `sessions_run_kind_idx` above does: Prisma's schema language has no way to say
-- it. `packages/db/test/scores-period-key.test.ts` reads this file as text and
-- fails if it stops declaring the constraint, because a silently-dropped unique
-- index is invisible until duplicate score rows appear on a dashboard.

CREATE UNIQUE INDEX IF NOT EXISTS scores_subject_scorer_period_key
  ON "scores" (subject_type, subject_id, scorer_name, scorer_version, period_start)
  NULLS NOT DISTINCT;

-- ─────────────────────────────────────────────────────────────────────────────
-- The run_kind guard, expressed once instead of remembered ~140 times (P13-012).
--
-- Before these views, every human-facing read carried a `run_kind = 'INTERACTIVE'`
-- fragment and two source-scanning lints counted them. That worked the way a rule
-- at the wrong altitude works: the predicate was inline and drifted (org spend
-- read 121 sessions / $547.83 against a true 115 / $19.03); centralizing it found
-- 18 SQL and 22 ORM sites that had never adopted it; counting per literal then
-- found seven guards bound to a CTE while the driving query ran unfiltered; and
-- the ingest alert engine still had two unguarded `events` reads no lint could
-- see. Four rounds, each finding sites the previous round's mechanism could not.
--
-- A view ends that: a query either reads the filtered relation or it names the
-- base table, and naming the base table is the visible, greppable exception.
--
-- Cost check, settled before committing to the approach: the planner **inlines**
-- a simple view, so TimescaleDB chunk exclusion is unaffected. `EXPLAIN` on
-- `interactive_events` and on the equivalent filtered `events` query produce
-- byte-identical plans — same ChunkAppend, same index choice, 3 of 30 chunks
-- scanned either way.
--
-- `SELECT *` is deliberate. These views must track their base tables as columns
-- are added — `events` in particular gains them regularly — and an explicit
-- column list would silently stop exposing anything new.
--
-- **The star is expanded once, at view-creation time**, and the resolved column
-- list is frozen into the rewrite rule. Every column of `events` and `sessions`
-- exists before these two statements run, so a fresh database sees all of them.
-- A *later* numbered migration that adds an `events` column must therefore carry
-- its own `CREATE OR REPLACE VIEW interactive_events AS SELECT * FROM events
-- WHERE run_kind = 'INTERACTIVE';` in the same file, or the column is invisible
-- to every human-facing read in `apps/web`, which names the view rather than the
-- base table. That is not hypothetical — it is why the folded 0003 and 0004 each
-- carried one.
--
-- The three continuous aggregates above name explicit aggregates rather than
-- `*`, so they are unaffected by a new column, and must stay that way: a cagg
-- that picked up an attribution column would be the double count P14-004 exists
-- to avoid.

CREATE OR REPLACE VIEW interactive_sessions AS
  SELECT * FROM sessions WHERE run_kind = 'INTERACTIVE';

CREATE OR REPLACE VIEW interactive_events AS
  SELECT * FROM events WHERE run_kind = 'INTERACTIVE';

COMMENT ON VIEW interactive_sessions IS
  'Sessions a human actually had (P13-012). Read this, not `sessions`, from anything that reports on people. Reading the base table is the documented exception and needs a run-kind-exempt marker at the call site.';

COMMENT ON VIEW interactive_events IS
  'Events from sessions a human actually had (P13-012). Read this, not `events`, from anything that reports on people. The planner inlines the view, so hypertable chunk exclusion is unaffected.';
