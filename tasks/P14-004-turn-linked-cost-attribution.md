---
id: P14-004
title: Turn-linked cost attribution for tools, skills and sub-agents
phase: 14
workstream: A
status: review
owner: claude
depends_on: [P14-001, P14-003]
blocks: []
estimate: L
---

## Goal

Tools, skills and sub-agents carry a **real** attributed cost at all three levels
(org, team, user), computed by redistributing each assistant turn's cost onto the
tool calls that turn issued — replacing the two fictions the product showed
before, and showing a coverage fraction rather than a false `$0.00` wherever the
underlying turn linkage is absent.

## Context

Real spend accrues per **assistant turn**, not per tool call. Ingest prices the
`Stop` event that closes a turn (`apps/ingest/src/lib/insert-events.ts` sets
`cost_usd` only for events carrying an `llm` block); `PreToolUse` /
`PostToolUse` events carry no tokens and are priced at nothing. So every
"what did this tool cost?" number is necessarily a redistribution.

Before this task the product showed two fictions in place of one:

- **Skills** showed `AVG(sessions.total_cost_usd)` over sessions that happened to
  invoke the skill (`org-queries.ts` `getSkillUsage`) — a session-level proxy
  credited entirely to one skill.
- **MCP servers and sub-agents** showed `SUM(events.cost_usd)` over tool events,
  non-NULL only because `packages/db/src/seed.ts` fabricates it.
  [`P14-001`](./P14-001-subagent-identification-fix.md) replaced those tiles with
  an honest not-yet-captured state; this task makes them real.

The turn linkage itself is [`P14-003`](./P14-003-turn-linked-cost-attribution.md)
(hook side): `events.turn_number` and `events.parent_event_id`, both already in
the `events` DDL and both written NULL until that lands.

## The two attributions

Defined once, as pure functions, in `apps/ingest/src/lib/cost-attribution.ts`.

**Issuing-turn share** — `events.attributed_cost_usd`:

```
attributed_cost_usd(t) = Stop(N).cost_usd / count(PostToolUse events in turn N)
```

An even split, because nothing in the payload says which of a turn's tool calls
the model spent its tokens deciding on. Attribution lands on `PostToolUse` rows
only, and the divisor counts only those: a completed call emits both `PreToolUse`
and `PostToolUse`, and splitting across both would halve every number, since every
per-tool aggregate in `apps/web` filters `event_type = 'PostToolUse'`.

A turn that issued no tools keeps its cost unattributed, so **the sum of this
column over a session is ≤ the session total**. The difference is the model's own
thinking, which belongs to no tool.

**Downstream inflation** — `events.downstream_cost_usd`:

```
downstream_cost_usd(t) = inputSideCost(Stop(N+1)) * b_t / SUM(b) over turn N
inputSideCost(e)       = input*rate_in + cache_read*rate_cr + cache_write*rate_cw
```

A tool's output is pasted back into the conversation and re-read by the *next*
turn, so a chatty tool costs money it never appears next to. Input-side means
input + cache-read + cache-creation and deliberately **not** output tokens, which
are the model's own generation. Rates come from `resolveModelPrice`
(`apps/ingest/src/lib/cost.ts`) — the same lookup ingest uses, including its
`<provider>/` prefix fallback — so the downstream half is priced identically to
the cost it redistributes.

**This half is an approximation.** Bytes proxy for tokens, and the ratio varies
by content: JSON and source code tokenize very differently from prose. It is
right about which tools are expensive and roughly right about by how much; it is
not an invoice line. Said in the code comment and in the UI caption.

## THE INVARIANT

The two columns are **two lenses on the same dollars, not two costs**. Turn N+1's
cost appears once as its own tools' issuing share and again as turn N's tools'
downstream inflation. Therefore:

- Never sum them together, never total them into one "cost" column.
- Never let either feed `sessions.total_cost_usd`, `pr_rollups.total_cost_usd`,
  or the three continuous aggregates in `0001_init.sql`. That four-way chain
  (documented in the header of `apps/ingest/src/jobs/reprice-events.ts`) already
  counts these dollars exactly once, at the Stop event.

`apps/ingest/test/compute-cost-attribution.test.ts` asserts the job issues no
write against any of them; `apps/web/test/cost-attribution-surfaces.test.ts`
asserts nothing in the query layer or on any page adds the two columns, in SQL or
in TypeScript, in either operand order.

## NULL is not zero

Both columns are nullable and stay NULL when there is no turn linkage, or when
the issuing turn's model has no price row (the P8-002 rule: an unpriced model
bills nothing rather than being guessed at). Rendering that as `$0.00` would
present a gap in capture as a measurement — the exact fiction this phase exists
to remove. So:

- The query layer sums them bare, with **no** `COALESCE(..., 0)`.
- `sumAttributed` / `addNullable` (`apps/web/src/lib/attribution-coverage.ts`)
  keep NULL through aggregation rather than letting `null + x` become `0 + x`.
- `fmtUsdOrDash` renders NULL as an em dash.
- Every surface carries `CostAttributionNote`, which states the coverage
  fraction: what proportion of the window's sessions have turn linkage at all.
  Coverage is measured from `turn_number`, **not** from the cost columns — a turn
  that issued no tools legitimately attributes nothing, and counting that as
  missing coverage would be a second wrong number.

## Acceptance criteria

- [x] `events` carries nullable `attributed_cost_usd` and `downstream_cost_usd`,
      added in a new numbered SQL migration (`0003_tool_cost_attribution.sql`),
      with `0001_init.sql` untouched.
- [x] That migration also redefines `interactive_events` — the view is
      `SELECT *`, which Postgres expands at creation time, so a new `events`
      column is invisible through it until the view is replaced.
- [x] A scheduled job `compute-cost-attribution` computes both attributions for
      **settled** sessions only and writes them chunk by chunk, decompressing a
      chunk only when it is compressed and recompressing only what it
      decompressed.
- [x] Running the job twice produces the same numbers, not doubled ones.
- [x] The session / PR / continuous-aggregate cost chain is provably unchanged by
      the job.
- [x] Tools, skills and sub-agents show both figures at org, team and user level;
      the P14-001 "Not yet captured" tiles on `/org/agents`,
      `/team/[slug]/agents`, `/org/mcp` and `/team/[slug]/mcp` show real numbers.
- [x] The skills tables keep the existing "Avg session $" proxy column beside the
      new ones — replacing it silently would change what an existing number means
      without telling anyone.
- [x] Every query respects `share_metadata_with_org` / `share_metadata_with_team`
      through the existing `orgVisibleUserIds` / `resolveTeamVisibility` seams,
      and reads `interactive_events` so CI and eval runs never reach a
      human-facing aggregate.
- [x] Sessions with NULL `turn_number` produce **no** attribution rather than
      wrong attribution, and the UI shows a coverage indicator rather than
      `$0.00`.
- [x] Unit tests cover: an even split across N tools; a turn with zero tools
      attributing nothing; NULL `turn_number` yielding no attribution; and the
      downstream proportions summing to one across a turn's feeding tools.

## Implementation notes

The attribution arithmetic is **in TypeScript, not SQL** — a pure function over a
session's events. That is what makes each definition directly testable; a SQL
expression could not be exercised without a live database, and these are numbers
the product prints next to a dollar sign.

The job therefore: selects settled sessions in a lookback window (default 7 days,
matching the compression policy so the nightly run ordinarily touches only
uncompressed chunks), reads their turn-linked events, computes in process, then
writes back grouped by chunk. Values cross as text and are cast in-database — a
`NUMERIC(12,6)` round-tripped through a JS double would occasionally land a
half-ulp away and defeat the `IS DISTINCT FROM` guard, turning every run into a
full rewrite.

**No report/apply interlock**, unlike `reprice-events`. That job's two names exist
because it *rewrites a measured number* — historical `cost_usd` — and a mistake is
unrecoverable without the original price table. This one assigns a derived value
from rows it does not modify, is a pure function of those rows, and re-running is
a no-op; a dry run would report a diff nobody could act on differently.

The decompress → update → recompress dance moved out of `reprice-events.ts` into
`apps/ingest/src/lib/hypertable-chunks.ts` rather than being retyped from memory:
the details that make it work (the `::text` casts, recompressing only what was
compressed, scoping the write by time range rather than `tableoid`) are exactly
the kind that get dropped in a second copy.

## Files touched

- `packages/db/sql/migrations/0003_tool_cost_attribution.sql`, `packages/db/AGENTS.md`
- `apps/ingest/src/lib/cost-attribution.ts`, `apps/ingest/src/lib/hypertable-chunks.ts`
- `apps/ingest/src/jobs/compute-cost-attribution.ts`, `apps/ingest/src/jobs/scheduler.ts`
- `apps/ingest/src/jobs/reprice-events.ts` (uses the extracted chunk helper), `apps/ingest/AGENTS.md`
- `apps/ingest/test/cost-attribution.test.ts`, `apps/ingest/test/compute-cost-attribution.test.ts`,
  `apps/ingest/test/compute-cost-attribution.db.test.ts`
- `apps/web/src/lib/attribution-coverage.ts`, `apps/web/src/lib/fmt.ts`
- `apps/web/src/lib/org-queries.ts`, `apps/web/src/lib/team-queries.ts`, `apps/web/src/lib/insights-queries.ts`
- `apps/web/src/components/CostAttributionNote.tsx`, `apps/web/src/components/team-org/AgentsTable.tsx`,
  `apps/web/src/components/team-org/McpServerCard.tsx`
- `apps/web/src/app/org/{tools,skills,skills/[kind]/[name],agents,mcp}/page.tsx`
- `apps/web/src/app/team/[slug]/{tools,skills,skills/[kind]/[name],agents,mcp}/page.tsx`
- `apps/web/src/app/me/insights/page.tsx`
- `apps/web/test/cost-attribution-surfaces.test.ts`

## Out of scope

- **Producing the turn linkage.** `turn_number` / `parent_event_id` are written by
  the hook adapters — [`P14-003`](./P14-003-turn-linked-cost-attribution.md).
- **Deriving turn linkage heuristically** where the adapter cannot report it
  (e.g. assigning each tool event to the nearest following `Stop` by timestamp).
  Considered and declined: parallel tool calls, Claude Code's response-cycle-vs-
  API-turn mismatch, and hook-time vs assistant-message-time skew all move a call
  into the wrong turn's divisor, and the symptom is a plausible dollar figure on
  the wrong tool. Its own task, with its own error analysis, if wanted.
- **Retiring the "Avg session $" proxy** on the skills tables. It stays beside
  the real numbers until someone decides to remove it.
- **Token-accurate downstream attribution.** Apportioning by output bytes is the
  approximation this task ships; counting tokens would mean tokenizing stored
  tool output, which the content-free capture policy does not keep.
- Sub-agent identification ([`P14-001`](./P14-001-subagent-identification-fix.md))
  and the tool-category taxonomy ([`P14-002`](./P14-002-tool-category-taxonomy.md)).
- **The model-routing surfaces, which have the same bug and are not fixed here.**
  Found while checking what the P14-003 seed change touches; see "Adjacent
  finding" below. Fixing them means designing a *different* redistribution (spend
  per model per tool category, not per tool call), across six call sites one of
  which is an alert. That is its own task, not a rider on this one.

## Adjacent finding — the routing surfaces are dead the same way

Six reads sum `events.cost_usd` over rows matching
`event_type = 'PostToolUse' AND model IS NOT NULL AND tool_category IS NOT NULL`:

| Where | Function |
|---|---|
| `apps/web/src/lib/org-queries.ts` | `getOrgModelRoutingBreakdown`, `getRoutingSpendByTeam` |
| `apps/web/src/lib/team-queries.ts` | `getTeamRoutingBreakdown` |
| `apps/web/src/lib/insights-queries.ts` | `getUserModelRouting` |
| `apps/web/src/lib/projection-queries.ts` | `getRoutingActuals` |
| `apps/ingest/src/jobs/evaluate-alerts.ts` | the `routing_waste` evaluator |

**No adapter puts a model on a `PostToolUse` row.** All three producers of an
`llm` block attach it to `Stop`: `adapters/codex.ts` (`stopWithUsage` /
`withModelOnly`), `adapters/gemini-cli.ts` (drains the turn's usage onto the
Stop), and `lib/import-synth.ts`. So `model IS NOT NULL` matches zero tool rows
in real telemetry, independently of the cost column — and `tool_category` is the
second NULL predicate, which is P14-002's mandate.

Note the shape of the guarantee, because it changes the fix: `packages/schemas`
puts `llm` in `baseEventShape`, so the wire contract **permits** an `llm` block
on a `PostToolUse` event. Nothing forbids it; no producer does it. So this cannot
be pinned by a schema assertion, and if some adapter later started attaching
usage to tool rows, these six queries would silently come alive with
partially-correct numbers covering only that one agent — worse than the current
honest emptiness. Whoever fixes this should decide the definition first and make
the queries state it, rather than letting producer behaviour decide it for them.

This is the *same class* of bug P14-001 diagnosed — a query filtered on a value
no producer emits — reaching a surface that investigation did not scan:
`/org/models`, the routing recommendations, the projection-realization panel, and
a live alert. Everything anyone has seen on them came from `packages/db/seed.ts`.

It has been latent, not new. What makes it visible now is P14-003 moving the
seeded token/cost columns off `PostToolUse` rows onto per-turn `Stop` rows — the
right change, and it removes the fabrication that was masking this.

Whoever picks it up should decide the definition first, not the query: "spend on
model M for tool category C" is a *routing* question about which model served a
turn, so it probably wants the `Stop` row's model against the categories of the
tools that turn issued — not this task's per-tool split. **Needs a task ID
assigned**; deliberately not claimed here, because three agents are renumbering
Phase 14 concurrently and a guessed ID is how the last collision happened.

## Verification

```bash
bun install
bun run check
bun run typecheck
bun run build
bun run test
```

The attribution arithmetic and the job's control flow are covered by
`apps/ingest/test/cost-attribution.test.ts` and
`apps/ingest/test/compute-cost-attribution.test.ts`, which need no database.

The parts a mock cannot reach — that the migration applied, that the two columns
are visible through `interactive_events`, that a compressed chunk survives the
write, and that `NUMERIC(12,6)` stores what JS computed — live in
`apps/ingest/test/compute-cost-attribution.db.test.ts`, which skips unless
`DATABASE_URL` is set:

```bash
bun run docker:infra:up
bun run db:deploy
DATABASE_URL=<url> bun run --cwd apps/ingest test
```
