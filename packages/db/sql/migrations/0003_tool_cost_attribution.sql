-- P14-004 — turn-linked cost attribution.
--
-- Applied ONCE, tracked by filename in `_db_sql_migrations`
-- (packages/db/src/sql-migrate.ts). `0001_init.sql` is NOT edited: an edit to an
-- already-applied migration is invisible to the name-based idempotency check and
-- silently never runs (packages/db/AGENTS.md, "the drift trap").
--
-- ── What these two columns are, and what they are not ────────────────────────
--
-- Real spend accrues per **assistant turn**, not per tool call. A turn's `Stop`
-- event carries the model and the four token counts, so ingest prices it into
-- `events.cost_usd`; the `PreToolUse`/`PostToolUse` rows for the tools that turn
-- issued carry no tokens of their own and are priced at nothing. Every "cost by
-- tool / skill / sub-agent" number the product wants therefore has to be
-- *redistributed* from the turn onto the calls that turn made.
--
-- `attributed_cost_usd`  — the issuing turn's own cost, split evenly across the
--                          `PostToolUse` events that turn issued.
-- `downstream_cost_usd`  — the marginal **input-side** cost this tool's output
--                          imposed on the *following* turn, apportioned by
--                          `tool_output_bytes`.
--
-- **They are two lenses on the same dollars, and they are NOT additive.** Never
-- sum them together, and never let either feed `sessions.total_cost_usd`,
-- `pr_rollups.total_cost_usd`, or the three continuous aggregates in
-- `0001_init.sql` — that chain already counts these dollars exactly once, at the
-- Stop event (see the header of `apps/ingest/src/jobs/reprice-events.ts`, which
-- documents the four-way chain these columns must stay out of).
--
-- Both are nullable with no default, which is what TimescaleDB accepts on an
-- already-compressed hypertable without a rewrite. NULL means "not attributed"
-- — either the turn linkage (`turn_number` / `parent_event_id`) is absent, or
-- the issuing turn's model had no price row. It never means "$0.00 of cost".

ALTER TABLE events ADD COLUMN IF NOT EXISTS attributed_cost_usd NUMERIC(12, 6);
ALTER TABLE events ADD COLUMN IF NOT EXISTS downstream_cost_usd NUMERIC(12, 6);

COMMENT ON COLUMN events.attributed_cost_usd IS
  'P14-004: the issuing turn''s cost_usd divided evenly across the PostToolUse events that turn issued. NULL = not attributed. Not additive with downstream_cost_usd, and never rolled into sessions.total_cost_usd.';
COMMENT ON COLUMN events.downstream_cost_usd IS
  'P14-004: the following turn''s input-side cost apportioned to this tool call by tool_output_bytes. An approximation — bytes proxy for tokens. NULL = not attributed. Not additive with attributed_cost_usd.';

-- ── Indexes: deliberately none ───────────────────────────────────────────────
--
-- No index is added here, and that is a decision rather than an omission.
--
-- Every dashboard aggregate that reads these columns is a `SUM()` bolted onto a
-- scan that already exists and is already indexed: the tool tables filter
-- `(user_id, ts)` and group by `tool_name` (`events_user_id_ts_idx`,
-- `events_tool_name_ts_idx`), the MCP tables add `mcp_server IS NOT NULL`
-- (`events_mcp_server_ts_idx`), the skill tables `skill_name IS NOT NULL`
-- (`events_skill_name_ts_idx`), and the sub-agent tables `subagent_type IS NOT
-- NULL`. Adding these two columns changes only what is summed off rows the
-- planner was already going to visit, so an index on either would be read by
-- nothing.
--
-- The attribution job does not need one either. It walks `events` chunk by chunk
-- (the same shape as `reprice-events`) and joins the rows it computed back by
-- `(event_id, ts)`, which `events_event_id_key` already covers, and reads a
-- session's events through `events_session_id_ts_idx`.
--
-- A partial index on `attributed_cost_usd IS NOT NULL` was considered for the
-- coverage indicator and rejected: coverage is measured from `turn_number`, over
-- the same windowed scan the page is already doing.
--
-- Add one when a query plan says so, not before.

-- ── The filtered view has to be redefined ────────────────────────────────────
--
-- `interactive_events` is `SELECT * FROM events WHERE run_kind = 'INTERACTIVE'`,
-- and Postgres expands `*` at view-creation time. Without this the two new
-- columns exist on the hypertable but are invisible to every human-facing read
-- in `apps/web`, which names the view rather than the base table (P13-012).
-- `CREATE OR REPLACE VIEW` permits columns appended at the end, which is exactly
-- what the two `ALTER TABLE`s above produced.
CREATE OR REPLACE VIEW interactive_events AS
  SELECT * FROM events WHERE run_kind = 'INTERACTIVE';
