-- P14-006 — the join key that closes turn linkage for LIVE tool events.
--
-- Applied ONCE, tracked by filename in `_db_sql_migrations`
-- (packages/db/src/sql-migrate.ts). `0001_init.sql`, `0002_*` and `0003_*` are
-- NOT edited: an edit to an already-applied migration is invisible to the
-- name-based idempotency check and silently never runs (packages/db/AGENTS.md,
-- "the drift trap").
--
-- ── What this column is for ──────────────────────────────────────────────────
--
-- P14-003 gave Claude Code real per-turn usage but could not give LIVE
-- `PreToolUse`/`PostToolUse` events their `turn_number` / `parent_event_id`:
-- each tool hook is its own short-lived process that fires BEFORE the Stop of
-- the turn that issued it, so the Stop's id does not exist yet — and the only
-- place the linkage is derivable is the session transcript, which
-- `apps/hook/AGENTS.md` forbids a tool-lifecycle hook from reading. Turn linkage
-- therefore populated for IMPORTED sessions only, and P14-004's per-tool cost
-- attribution showed a coverage indicator for live ones.
--
-- What closes it is not a heuristic but a natural key. Claude Code's hook input
-- contract carries `tool_use_id` on both tool hooks (verified against the
-- shipped binary's own schema, not from memory), and the transcript repeats the
-- SAME id on the `tool_use` block of the assistant turn that issued the call.
-- So the turn is knowable at Stop, the call is knowable at the tool hook, and
-- both name it identically. `apps/ingest/src/jobs/link-turn-events.ts` joins
-- them on `(session_id, tool_use_id)`.
--
-- Opaque by design: nothing parses this value, and it is only ever compared
-- within one `session_id`. It is the agent's own string, so a future agent with
-- a per-call id of its own shape needs no schema change to adopt the same join.
--
-- Nullable with no default, which is what TimescaleDB accepts on an
-- already-compressed hypertable without a rewrite. NULL means "this agent (or
-- this event) supplies no per-call id" — every non-tool event is NULL, and so is
-- every tool event from an agent that has not adopted the key.

ALTER TABLE events ADD COLUMN IF NOT EXISTS tool_use_id TEXT;

COMMENT ON COLUMN events.tool_use_id IS
  'P14-006: the host agent''s own identifier for one tool call (Claude Code''s tool_use_id, toolu_...). The natural key the link-turn-events job joins live tool events to transcript-derived turn linkage on, within a single session_id. Opaque — never parsed. NULL for non-tool events and for agents that supply no per-call id.';

-- ── The index, and why it is partial ─────────────────────────────────────────
--
-- Unlike 0003, this one IS read by a query that does not otherwise exist: the
-- linkage job looks up a batch of sessions' unlinked tool rows by
-- `(session_id, tool_use_id)`. `events_session_id_ts_idx` gets it to the
-- session; without this it then scans every event in that session to find the
-- handful whose id is being linked.
--
-- Partial on `tool_use_id IS NOT NULL` because the column is NULL on every
-- non-tool event and on every agent that has not adopted the key — today that
-- is six of the seven — so the full index would be mostly dead entries on the
-- largest table in the schema. The predicate is one the job's own WHERE clause
-- states, so the planner can use it.
CREATE INDEX IF NOT EXISTS events_session_tool_use_id_idx
  ON events (session_id, tool_use_id)
  WHERE tool_use_id IS NOT NULL;

-- ── The filtered view has to be redefined ────────────────────────────────────
--
-- `interactive_events` is `SELECT * FROM events WHERE run_kind = 'INTERACTIVE'`,
-- and Postgres expands `*` at view-CREATION time and stores the resolved column
-- list in the rewrite rule. Without this, `tool_use_id` exists on the hypertable
-- but is invisible to every human-facing read in `apps/web`, which names the
-- view rather than the base table (P13-012). 0003 left this as a standing rule
-- for the next migration that adds an `events` column; this is that migration.
--
-- The three continuous aggregates (`daily_cost_by_user`, `daily_cost_by_model`,
-- `daily_tool_usage`) name explicit aggregates rather than `*`, so they are
-- unaffected and are deliberately not touched. `interactive_sessions` is over a
-- different table.
CREATE OR REPLACE VIEW interactive_events AS
  SELECT * FROM events WHERE run_kind = 'INTERACTIVE';
