---
id: P8-001
title: Tool-name disambiguation (<agent>:<tool> convention)
phase: 8
workstream: B
status: done
owner: claude
depends_on: [P5-006]
blocks: [P8-004]
estimate: M
---

## Decision

**Query-time disambiguation (approach 2).** The write path already committed to
this: `insert-events.ts` stores `tool_name` raw with the comment *"disambiguate by
(agent_type, tool_name) at query time when needed"*, and the `daily_tool_usage`
continuous aggregate already groups by `agent_type`. Prefix-on-write was rejected
because it would (a) require a backfill of every historical `events` row, (b) mangle
the displayed tool name for the single-agent (claude_code-only) deployments that are
the norm today, and (c) fight the existing schema. Query-time keeps stored data
untouched and is a no-op for single-agent reads.

Implementation: every tool aggregate `GROUP BY tool_name` becomes
`GROUP BY agent_type, tool_name`; a shared `labelToolRows()` helper
(`apps/web/src/lib/tool-usage.ts`) prefixes `<agent_type>:<tool>` **only when the
result set spans more than one agent**, so single-agent output is identical to today.
Per-session breakdown needs no change — a session has exactly one `agent_type`, so
same-named tools cannot collide within it.

## Goal

Implement the `<agent>:<tool>` collision-avoidance convention from DESIGN_DOC.md §2.4 so two agents emitting a tool with the same name (e.g. `"Edit"`) are distinguishable in every tool aggregate.

## Context

DESIGN_DOC.md §2.4 documents the `<agent>:<tool>` convention as a first-class design decision ("Tool naming uses a `<agent>:<tool>` convention internally to prevent collisions"), but `apps/ingest/src/lib/insert-events.ts` stores `tool_name` raw from the payload — no prefix is applied. Any second agent emitting `"Edit"` would merge into the same bucket as `claude_code:Edit` in every aggregate today. The fix must be consistent: both writes and reads must use the same representation so existing `claude_code` data continues to read correctly.

Two viable approaches:

1. **Prefix on write** — `insert-events.ts` prepends `<agent_type>:` before persisting `tool_name`; all existing read queries work unchanged because the raw string now carries the prefix.
2. **Disambiguate at query time** — store raw names but always GROUP BY `(agent_type, tool_name)` in every tool aggregate query; add a computed label for display.

Approach (1) is simpler operationally (one change site, no backfill required for new data) but requires a migration/backfill plan for existing rows. Approach (2) avoids touching the stored data but requires discipline at every query site. Choose one, document the decision in the task file, and apply it consistently.

## Acceptance criteria

- [x] The chosen approach (prefix-on-write or query-time) is documented in this file under a `## Decision` heading added when the task is claimed.
- [x] Two agents emitting a tool named `"Edit"` produce distinct rows (or distinct aggregates) in: per-session tool breakdown, team tool usage, org tool usage, and `daily_tool_usage` continuous aggregate.
- [x] Existing `claude_code` data reads correctly after the change (no behavior change for single-agent deployments).
- [x] If prefix-on-write: a migration/backfill plan for existing rows is stated (even if the backfill is a one-off script, not a migration — state it explicitly).
- [x] If query-time: every tool aggregate query in `apps/web/src/lib/*-queries.ts` groups by `(agent_type, tool_name)` and unit tests cover the multi-agent case.
- [x] `bun run typecheck` passes; `bun run check` passes.

## Implementation notes

Prefix-on-write sketch: in `insert-events.ts`, when persisting `tool_name`, apply `${agent_type}:${tool_name}` before the insert. Existing rows have raw names; a backfill can be `UPDATE events SET tool_name = agent_type || ':' || tool_name WHERE tool_name NOT LIKE '%:%'`. This one-liner is safe to run once and idempotent.

Query-time sketch: keep stored names raw; in every GROUP BY that involves `tool_name`, also group by `agent_type` and surface `agent_type || ':' || tool_name` as the display key. The risk is missing a query site — prefer approach (1) unless there's a strong reason.

## Files touched

- `apps/ingest/src/lib/insert-events.ts`
- `apps/web/src/lib/me-queries.ts`
- `apps/web/src/lib/team-queries.ts`
- `apps/web/src/lib/org-queries.ts`
- `apps/web/src/lib/sessions-queries.ts`
- `packages/db/sql/` (migration or backfill script if prefix-on-write)

## Out of scope

- Changing the wire format of the hook payload (the hook still sends raw tool names; prefix is applied server-side or at query time).
- Renaming existing `claude_code` tool records in the UI (labels remain the same for single-agent deployments).
- Any change to `packages/schemas` — `tool_name` in the event schema stays as a plain string.

## Verification

```bash
# Typecheck and lint
bun run typecheck
bun run check

# Unit tests
bun --filter '@app/ingest' test
bun --filter '@app/web' test

# Integration smoke (requires docker stack):
# POST two events with identical tool_name but different agent_type and confirm
# the tool aggregate returns two distinct rows.
```
