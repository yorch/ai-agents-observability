---
id: P10-001
title: Routing analysis query layer + defensible savings model
phase: 10
workstream: B
status: in-progress
owner: null
depends_on: [P8-002, P4-004, P7-001]
blocks: [P10-003, P10-004, P10-006]
estimate: M
---

## Goal

A tested query/derivation layer that aggregates cost and tokens by
`(agent_type, model, tool_category, shape_label)` and computes **savings ranges**
for candidate model downgrades, derived from the real per-agent price tables rather
than the current flat `DOWNGRADE_SAVINGS_RATE = 0.8` constant. This is the shared
foundation every Phase 10 surface reads from.

## Context

See [`P10-roadmap.md`](./P10-roadmap.md) and [`OPPORTUNITIES.md`](../OPPORTUNITIES.md)
§3.2. Today the savings math lives inline in
`apps/web/src/app/org/models/page.tsx` (`computeRoutingInsights`) with three
hardcoded assumptions: a flat `0.8` cost ratio, `PREMIUM_PATTERNS = ['opus']`, and
`CHEAP_CATEGORIES = {fs_read, search, web}`. The per-agent price tables from
`P8-002` (`apps/ingest/src/data/price-table.<agent>.v1.json`, served at
`/v1/price-table?agent=`) carry real per-model input/output/cache rates — the true
premium→standard→economy ratio is derivable per agent instead of assumed.

`DESIGN_DOC.md` §10.6: cost numbers are "precisely misleading without outcome
context" — so savings must be **ranges with volume gating**, not point estimates,
and callers must be able to suppress low-confidence rows.

## Acceptance criteria

*Audited against the code 2026-08-18 (see the implementation record). A partial tick
is written as `[ ]` with the gap named — the surface exists and works; these are the
properties it does not yet have.*

- [ ] **Partial.** A query function returns cost + token + call-count rollups grouped by
      `agent_type`, `model`, `tool_category`, and `shape_label` over a date range,
      scoped to the caller's visibility (org-visible users only for org callers).
      *`getOrgModelRoutingBreakdown` is correctly visibility-scoped via
      `orgVisibleUserIds`, but groups by `model, tool_category` only — neither
      `agent_type` nor `shape_label` is in the cut.*
- [ ] **Partial.** A pure, unit-tested `estimateRoutingSavings()` derives a downgrade savings
      **range** (low/high) from the live price-table ratio between a model's tier and
      the next-cheaper eligible tier **for that agent** — not a hardcoded constant.
      *`buildSavingsRatioResolver` is pure, unit-tested, and does derive `1 −
      targetRate/premiumRate` from the live table. Two gaps: the target is the
      globally cheapest Haiku-class entry rather than the next-cheaper eligible tier,
      and the low end of the range comes from `ROUTING_SAVING_FLOOR_FRACTION = 0.4`,
      a hardcoded fraction of the ceiling, not from a tier ratio.*
- [ ] Rows below a configurable volume floor (min calls and/or min cost) are marked
      `lowConfidence: true` so UI can suppress or de-emphasize them. *No volume floor
      exists anywhere in the routing path.*
- [ ] **Diverged deliberately — needs a decision, not just work.** When the price table
      lacks an entry for a model, the row is returned with `savings: null` (never a
      fabricated number), and this path is unit-tested. *The shipped code instead falls
      back to a flat `HAIKU_SAVINGS_RATIO = 0.9` and flags the UI via `pricePrecise`,
      so the surface degrades cleanly rather than going blank. That is a defensible
      choice and the opposite of what this criterion asks for. Settle which one the
      product wants before building to it.*
- [ ] Savings are computed per `agent_type`; a Claude Opus→Sonnet ratio is never
      applied to another agent's models. *`buildSavingsRatioResolver` takes one merged
      price map and picks the cheapest Haiku-class model in it, so another agent's
      economy rate can set the denominator for a Claude model. This is the exact
      contamination the criterion forbids.*
- [ ] **Partial.** Unit tests cover: normal downgrade range, missing-price-entry null, low-volume
      suppression, and multi-agent isolation. *`routing-queries.test.ts` covers the
      normal range, the 0.95 cap, and the missing-price fallback. There is no
      low-volume case (no floor to test) and no multi-agent isolation case.*

## Implementation notes

- New module, e.g. `apps/web/src/lib/routing-analysis.ts`, plus a query in
  `apps/web/src/lib/org-queries.ts` (or a new `model-optimization-queries.ts`).
- Reuse the continuous aggregate `daily_cost_by_model` (`P4-004`) where the grain
  matches; fall back to a scoped `events` aggregation for the `tool_category` ×
  `shape_label` cut, which the aggregates don't pre-compute.
- Read tier order from the model policy once `P10-002` lands; until then, accept an
  injected tier resolver so this task isn't blocked on the policy table.
- Keep the derivation pure and price-table-driven so `P10-006` can replay it against
  historical price tables.

## Files touched

- `apps/web/src/lib/routing-analysis.ts` (new)
- `apps/web/src/lib/routing-analysis.test.ts` (new)
- `apps/web/src/lib/org-queries.ts` (or `model-optimization-queries.ts`)

## Out of scope

- Any UI. This task is query + derivation + tests only (consumed by P10-003/004).
- The policy/config source (P10-002) — accept an injected tier resolver for now.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/web' test routing-analysis
bun run --cwd apps/web typecheck
```

## Implementation record — partial, reopened 2026-08-18

`INDEX.md` carried this as `done`; the file carried `ready`. Audited against the
code, neither was right, so it is reopened as `in-progress` with the gaps named
above.

**What shipped, under a different name.** Not `routing-analysis.ts` as planned but
`apps/web/src/lib/routing-queries.ts`, reached through Phase 8/11 work rather than
as this task. It is a real implementation of the core idea: pure, no DB access,
price-table-driven, unit-tested, and it produces a **range** rather than a point
estimate — `routingSavingRange`, registered as a P13-006 projection so the claim is
later checked against realized spend.

**What is missing is not cosmetic.** The rollup has no `agent_type` or `shape_label`
grain, there is no volume floor, and the savings resolver draws its target rate from
one merged price map — so a cheap model belonging to one agent can set the savings
denominator for another agent's premium model. That last one is the specific failure
mode criterion 5 was written to prevent, and it is live.

**One item is a design disagreement, not unfinished work.** The task says a missing
price entry must yield `savings: null`, "never a fabricated number". The code
deliberately returns a flat `0.9` and marks the surface imprecise. Whoever picks this
up should settle that first; building the rest against the wrong answer wastes the
work.

**Blocked in part on `P10-002`.** The tier order this task wants to read comes from
the model policy, which does not exist. The implementation notes anticipated that
and asked for an injected tier resolver — `SavingsRatioResolver` is that seam, so
the dependency is honoured, not ignored.
