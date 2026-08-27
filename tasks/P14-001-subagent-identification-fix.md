---
id: P14-001
title: Fix sub-agent identification and stop reporting fabricated tool cost
phase: 14
workstream: A
status: done
owner: claude
depends_on: []
blocks: [P14-003]
estimate: S
---

## Goal

Sub-agent spawns are correctly identified in every query that needs to find or
exclude them, and the org/agents, team/agents, org/mcp, and team/mcp pages stop
presenting a computed `SUM(cost_usd)` over tool events as real attributed cost
when no producer has ever populated that number in real telemetry.

## Context

`getOrgSubagentStats` / `getTeamSubagentStats` (`apps/web/src/lib/{org,team}-queries.ts`)
filtered `tool_category = 'agent'` to find sub-agent spawn events. No adapter has
ever emitted that value — every producer writes only `'mcp'` or `'builtin'`
(`apps/hook/src/lib/payload.ts`, `import-synth.ts`, `stdin-hook-factory.ts`, and
the adapters built on it: `codex.ts`, `pi-family.ts`, `gemini-cli.ts`;
`opencode.ts` hardcodes `'builtin'`). The filter matched zero rows, ever — the
`/org/agents` and `/team/[slug]/agents` "Sub-agent usage" panels have always
rendered empty, in seed data and in production alike.

The complementary exclusion (`tool_category != 'agent'`, used by `getToolStats`
/ `getToolCategoryBreakdown` to keep spawns out of the "Top tools" tables) was
equally dead for the same reason, and had a second, independent bug: in SQL,
`NULL != 'agent'` evaluates to `NULL`, which `WHERE` treats as false — so every
event with a `NULL` `tool_category` was silently dropped from those aggregates,
not just sub-agent spawns.

Separately, `getOrgSubagentStats` / `getTeamSubagentStats` (and
`getMcpServerDetails` / `getTeamMcpDetails`) compute `SUM(cost_usd)` over tool
events for an "Attributed cost" tile. `apps/ingest/src/lib/insert-events.ts`
only sets `cost_usd` when an event carries an `llm` block, and for Claude Code
the only producer of one is the transcript importer, which attaches it
exclusively to `Stop` events — tool events never carry cost in real telemetry.
The only reason these tiles ever showed a number was `packages/db/src/seed.ts`
fabricating a `cost_usd` on every seeded `PostToolUse` row.

See also `apps/web/src/lib/insights-queries.ts` (`getSubagentUsage`) and
`apps/web/src/lib/sessions-queries.ts` (per-session sub-agent breakdown), which
already used the correct pattern (`subagent_type IS NOT NULL`) and were the
reference this fix matches.

## Acceptance criteria

- [x] `getOrgSubagentStats` and `getTeamSubagentStats` identify a sub-agent
      spawn by `subagent_type IS NOT NULL` on `PostToolUse` events, not
      `tool_category = 'agent'`.
- [x] `getToolStats`, `getToolCategoryBreakdown` (org and team variants)
      exclude sub-agent spawns via `subagent_type IS NULL` — NULL-safe, so rows
      with a `NULL` `tool_category` are no longer silently dropped.
- [x] No query in `org-queries.ts` / `team-queries.ts` compares `tool_category`
      to the literal `'agent'`.
- [x] The "Attributed cost" / "Avg cost / spawn" tiles on `/org/agents` and
      `/team/[slug]/agents`, and the "Attributed LLM cost" tile on `/org/mcp`
      and `/team/[slug]/mcp`, render an explicit "Not yet captured" state
      instead of a computed dollar figure or a bare dash.
- [x] A regression test (`apps/web/test/subagent-tool-category.test.ts`) derives
      the set of `tool_category` values adapters can actually emit from the
      adapter source and asserts no literal comparison in the two fixed query
      modules names a value outside it — confirmed to fail on the pre-fix code
      and pass on the fix.
- [x] `bun run check`, `bun run typecheck`, `bun run build`, `bun run test` all
      pass.

## Implementation notes

- The identification fix is a two-line pattern repeated at three call sites per
  file (`getToolStats`, `getToolCategoryBreakdown`, `get{Org,Team}SubagentStats`):
  swap the `tool_category` literal comparison for a `subagent_type` NULL check.
- The cost tiles keep the underlying `SUM(cost_usd)` in the query layer (needed
  by per-row displays elsewhere, e.g. `AgentsTable`, `McpServerCard`, which are
  unchanged) but the four named page-level tiles ignore the computed value and
  render a fixed honest-state string with a caption, per the `Stat` primitive's
  existing `sub` prop.

## Files touched

- `apps/web/src/lib/org-queries.ts`
- `apps/web/src/lib/team-queries.ts`
- `apps/web/src/app/org/agents/page.tsx`
- `apps/web/src/app/team/[slug]/agents/page.tsx`
- `apps/web/src/app/org/mcp/page.tsx`
- `apps/web/src/app/team/[slug]/mcp/page.tsx`
- `apps/web/test/subagent-tool-category.test.ts`
- `tasks/P14-001-subagent-identification-fix.md`
- `tasks/INDEX.md`

## Out of scope

- Real turn-linked cost attribution for tool events — that is
  [`P14-003`](./P14-003-turn-linked-cost-attribution.md).
- The tool-category taxonomy in the hook (`fs_read`/`fs_write`/`exec`/`web`/
  `search`, currently unpopulated by any adapter) — that is
  [`P14-002`](./P14-002-tool-category-taxonomy.md), in progress in parallel.
  `apps/hook/**` and `packages/schemas/**` were not touched.
- Per-row cost displays inside `AgentsTable` and `McpServerCard` — the same
  underlying gap, but not named in the fix's scope and left unchanged to avoid
  conflicting with parallel work.
- `packages/db/src/seed.ts`'s fabricated per-tool-event `cost_usd` — left as is;
  the honest-state UI fix makes it stop mattering for these four tiles, and
  reworking seed cost realism is separate from this defect.

## Verification

```bash
bun install
bun run check
bun run typecheck
bun run build
bun run test
```

`bun run test -- subagent-tool-category` runs the regression test in isolation.
No live database was used to verify this task — all four gates are static
analysis, typecheck, build, and unit tests; the sibling stack was left running
for other concurrent agents.
