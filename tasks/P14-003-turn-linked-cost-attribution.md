---
id: P14-003
title: Turn-linked cost attribution for tool events
phase: 14
workstream: A
status: blocked
owner: null
depends_on: [P14-001]
blocks: []
estimate: L
---

## Goal

Individual tool-call events (and, downstream, sub-agent spawns and MCP calls)
carry real attributed cost, so the "Attributed cost" / "Avg cost / spawn" /
"Attributed LLM cost" tiles this task's dependency (P14-001) changed to say
"Not yet captured" can show a real number instead.

## Blocker

Blocked on [`P14-001`](./P14-001-subagent-identification-fix.md): the honest
not-yet-captured state it shipped is the correct interim behavior, and this
task should land after it so the two don't race on the same tiles.

## Context

`apps/ingest/src/lib/insert-events.ts:49` sets `cost_usd` on an event only when
it carries an `llm` block. For Claude Code the only producer of an `llm` block
is the transcript importer (`apps/hook/src/lib/import-synth.ts:~189`), and it
attaches one exclusively to `Stop` events — once per turn, not once per tool
call. Tool events (`PostToolUse`) therefore never carry cost in real telemetry
today; every dollar figure ever shown for a sub-agent spawn or MCP call came
from `packages/db/src/seed.ts` fabricating a `cost_usd` on seeded rows,
diagnosed and stopped from displaying by P14-001.

Turn-linking means associating each `Stop` event's per-turn cost back to the
tool calls that happened within that turn (bounded by `turn_number`, already a
column on `events`) so a proportional or exact share of the turn's cost can be
attributed to, e.g., a specific sub-agent spawn or MCP tool call within it.

## Acceptance criteria

- [ ] A defined, documented method attributes turn-level `cost_usd` down to the
      tool events within that turn (proportional by token usage, by duration,
      or exact if the underlying LLM API ever reports it per-call — pick one
      and justify it).
- [ ] `getOrgSubagentStats` / `getTeamSubagentStats` and `getMcpServerDetails` /
      `getTeamMcpDetails` read real, non-fabricated cost once this lands.
- [ ] The P14-001 "Not yet captured" tiles are updated to show the real
      computed value once cost is available (conditionally, or removed if
      attribution is always available going forward).
- [ ] Historical events without turn-linked cost degrade gracefully (still
      "Not yet captured", not a false zero).

## Implementation notes

Non-binding — unclaimed, not yet designed. Consider whether this belongs in
`apps/ingest` (attribute at ingest time) or as a scheduled recompute job
(similar to `apps/ingest/src/jobs/reprice-events` from P12-011), given that
turn cost may not be known until the `Stop` event arrives, after the tool
events it should attribute to.

## Files touched

- `apps/ingest/src/lib/insert-events.ts` (or a new attribution job)
- `apps/web/src/lib/org-queries.ts`, `apps/web/src/lib/team-queries.ts`
- `apps/web/src/app/org/agents/page.tsx`, `apps/web/src/app/team/[slug]/agents/page.tsx`
- `apps/web/src/app/org/mcp/page.tsx`, `apps/web/src/app/team/[slug]/mcp/page.tsx`

## Out of scope

- Sub-agent identification and the honest not-yet-captured interim state —
  P14-001.
- The tool-category taxonomy — P14-002.

## Verification

Not yet defined — write this section when the task is claimed and the
attribution method is chosen.
