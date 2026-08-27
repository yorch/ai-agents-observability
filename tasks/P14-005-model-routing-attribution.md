---
id: P14-005
title: Make the model-routing surfaces read real cost instead of seed fiction
phase: 14
workstream: A
status: review
owner: claude
depends_on: [P14-002, P14-003, P14-004]
blocks: []
estimate: M
---

## Goal

The six model-routing reads answer their question from telemetry an adapter
actually emits, instead of from a column no producer has ever written — and where
the underlying turn linkage is absent they show a coverage fraction rather than a
number.

## Context

Six reads asked "what did model M cost on tool category C?" as

```sql
SUM(cost_usd)
WHERE event_type = 'PostToolUse'
  AND model IS NOT NULL
  AND tool_category IS NOT NULL
```

| Where | Function |
|---|---|
| `apps/web/src/lib/org-queries.ts` | `getOrgModelRoutingBreakdown`, `getRoutingSpendByTeam` |
| `apps/web/src/lib/team-queries.ts` | `getTeamRoutingBreakdown` |
| `apps/web/src/lib/insights-queries.ts` | `getUserModelRouting` |
| `apps/web/src/lib/projection-queries.ts` | `getRoutingActuals` |
| `apps/ingest/src/jobs/evaluate-alerts.ts` | `evalRoutingWaste` |

**`events.model` is written only from an event's `llm` block**
(`apps/ingest/src/lib/insert-events.ts` — `${e.llm?.model ?? null}`), and every
producer of that block attaches it to a **`Stop`**: `adapters/claude-code.ts`
(`stopWithUsage`, one Stop per assistant turn), `adapters/codex.ts`
(`stopWithUsage` / `withModelOnly`), `adapters/gemini-cli.ts`, and
`lib/import-synth.ts`. So `model IS NOT NULL` matched **zero** `PostToolUse` rows
in real telemetry. The cost column was not even the binding constraint — the
predicate failed a clause earlier.

Consequence: `/org/models`, the routing recommendations, the projection-
realization panel (P13-006), the per-user routing hint on `/me/insights`, the
by-team accountability table, and the `routing_waste` **alert** have only ever
rendered rows fabricated by `packages/db/src/seed.ts`, which stamped a model onto
`PostToolUse` rows. Phase 10 was signed off on that. The alert was armed,
enabled, and permanently silent — nothing failed, it simply never fired.

Found and documented — with evidence — under "Adjacent finding" in
[`P14-004`](./P14-004-turn-linked-cost-attribution.md), which deliberately left
it unfixed because the fix is a *different* redistribution from that task's
per-tool split.

Note the shape of the guarantee, because it shaped the fix: `packages/schemas`
puts `llm` in `baseEventShape`, so the wire contract **permits** an `llm` block on
a `PostToolUse` event. Nothing forbids it; no producer does it. So this could not
be pinned by a schema assertion, and letting producer behaviour define the answer
would mean the queries silently come alive with partially-correct numbers the day
some adapter starts attaching usage to tool rows. The definition is therefore
stated in the query.

## The definition

**"Spend on model M for tool category C" is a claim about the turn that *chose*
M.** Three columns, three places:

| | Where it comes from | Why |
|---|---|---|
| model | the issuing turn's `Stop` row, via `parent_event_id` (P14-003) | that row is what selected the model |
| cost | the tool row's `attributed_cost_usd` (P14-004) | the issuing turn's cost, split across the calls it made |
| tool_category | the tool row | where P14-002 writes a real value |

**The issuing-turn share, not the downstream lens.** P14-004 stores two readings
of the same dollars. `downstream_cost_usd` is the *following* turn's input-side
cost, priced with the *following* turn's model — which may be a different model
entirely. Charging it to this turn's model would answer a different question at
the wrong rates. A routing recommendation multiplies observed spend by a price
ratio for the model that was used; only the issuing share is denominated in that
model's dollars. The two are never summed (P14-004's invariant, enforced by
`apps/web/test/cost-attribution-surfaces.test.ts`).

Showing both was considered and declined: the downstream figure belongs to a
different (model, category) cell than the one it would be printed in, so a
side-by-side column would invite exactly the addition the invariant forbids while
answering a question nobody asked on this page.

**Window boundary.** Both sides of the join are bounded by the window, so
Postgres can prune chunks on the hypertable. A turn whose `Stop` landed just
before the window while its tools landed just inside is not attributed. That is a
sub-minute edge on a windowed aggregate; the alternative is an unbounded
`event_id` probe into every chunk of the table.

## The seed divergence is the root cause of the *latency*

The bug was latent for the whole life of the feature because `seed.ts` wrote a
`model` onto `PostToolUse`, `UserPromptSubmit`, `Notification` and `SessionStart`
rows — none of which production writes one on. Every screenshot, demo and review
saw populated routing tables. The seed now writes the per-turn LLM columns
(`model`, the four token counts, `cost_usd`) **only on `Stop` rows**, matching
ingest, and `packages/db/test/seed-event-shape.test.ts` fails if one comes back.

## Acceptance criteria

- [x] All five web routing reads resolve the model through
      `turn.event_id = tool.parent_event_id AND turn.event_type = 'Stop'` and sum
      `tool.attributed_cost_usd`; none references a model on the tool-row alias.
- [x] The `routing_waste` evaluator joins its downgradeable triples against the
      issuing turn's `(agent_type, model)` and the tool row's `tool_category`,
      keeps `unnest`'s fixed parameter count, and names no base table (the alert
      engine's stricter run-kind rule).
- [x] Routing spend is `number | null` end to end; `addNullable` / `sumAttributed`
      carry the null through aggregation, and no `COALESCE(SUM(...), 0)` collapses
      it. A group with no attribution produces **no** recommendation rather than a
      $0 one.
- [x] `/org/models` and the team overview's routing card render
      `CostAttributionNote` with the coverage fraction, reusing
      `attribution-coverage.ts` rather than inventing a second affordance.
- [x] The `routing_waste` notification carries `attributedCalls` / `callCount`,
      so a fired alert says how much of the window it could measure, and `details`
      stays numbers-only.
- [x] `packages/db/src/seed.ts` writes per-turn LLM columns only on `Stop` rows.
- [x] Tests fail if any routing read goes back to a predicate no producer can
      satisfy, and every scan carries an anti-vacuity assertion.

## Files touched

- `apps/web/src/lib/org-queries.ts` (the canonical explanation of the
  redistribution lives here), `team-queries.ts`, `insights-queries.ts`,
  `projection-queries.ts`, `routing-queries.ts`, `recommendations.ts`
- `apps/web/src/components/team-org/RoutingByTeam.tsx`, `RoutingRecommendations.tsx`
- `apps/web/src/app/org/models/page.tsx`, `apps/web/src/app/team/[slug]/page.tsx`
- `apps/ingest/src/jobs/evaluate-alerts.ts`, `apps/ingest/src/lib/notify/payload.ts`
- `packages/db/src/seed.ts`
- `apps/web/test/model-routing-attribution.test.ts` (new),
  `apps/web/test/cost-attribution-surfaces.test.ts` (visibility form extended for
  the team-join query), `apps/web/test/recommendations.test.ts`,
  `apps/web/src/lib/routing-queries.test.ts`
- `packages/db/test/seed-event-shape.test.ts` (new)
- `apps/ingest/test/routing-waste-shape.test.ts`
- `apps/ingest/AGENTS.md`, `packages/db/AGENTS.md`

## Out of scope

- **Producing turn linkage on live tool events.** P14-003 honours the tool half of
  the linkage contract on the **import** path only: a live `PreToolUse` /
  `PostToolUse` hook fires in its own process *before* its turn's `Stop` exists
  and has no way to name the assistant entry that issued it, so live tool events
  carry NULL `turn_number` / `parent_event_id`. Until that changes, these surfaces
  are populated for imported sessions and show coverage for the rest. That is the
  honest state, and it is what the coverage note is for.
- **Backfilling `attributed_cost_usd`.** The `compute-cost-attribution` job
  computes it, over settled sessions in a 7-day lookback. A freshly seeded
  database has the linkage but not the attribution until that job runs, so a
  seeded `/org/models` shows "—" plus a coverage line rather than recommendations.
  Duplicating the job's arithmetic in the seed would recreate exactly the
  seed/production divergence this task exists to remove.
- **Widening the attribution job's lookback** so it reaches seeded history.
- **Retiring `getOrgModelDetail`'s spend-by-model table**, which reads the
  `daily_cost_by_model` continuous aggregate off `Stop` rows and was always
  correct.
- Anything under `apps/hook/**`, `packages/db/sql/migrations/**` or
  `packages/db/prisma/**` — no schema change was needed.

## Verification

```bash
bun install
bun run check
bun run typecheck
bun run build
bun run test
```

### What still needs a live database

Everything below a mocked Prisma is a source-level or unit claim. These need a
running stack and are **not** covered by the suite:

1. That the two-scan hash join actually prunes chunks — `EXPLAIN (ANALYZE)` on
   `getOrgModelRoutingBreakdown`'s SQL over a populated `events` hypertable.
2. That `SUM(tool.attributed_cost_usd)::text` round-trips a `NUMERIC(12,6)`
   without loss through the Prisma raw path (the same idiom `getToolPerf` uses,
   so this is regression rather than new risk).
3. That the redistribution produces a non-empty result at all, which requires
   `compute-cost-attribution` to have run over sessions carrying turn linkage:

   ```bash
   bun run docker:app:up
   bun run db:seed
   curl -XPOST localhost:4000/admin/jobs/compute-cost-attribution/run   # + auth
   ```

   Then `/org/models` should show attributed retrieval spend and a coverage
   fraction below 100% (the seed's basic cohort issues tool calls with no turn
   linkage on purpose, because live capture does the same).
4. That `routing_waste` can now fire — set `thresholdUsd` low on the rule and run
   `evaluate-alerts` against a database with attribution.
