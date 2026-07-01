---
id: P10-001
title: Routing analysis query layer + defensible savings model
phase: 10
workstream: B
status: ready
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

- [ ] A query function returns cost + token + call-count rollups grouped by
      `agent_type`, `model`, `tool_category`, and `shape_label` over a date range,
      scoped to the caller's visibility (org-visible users only for org callers).
- [ ] A pure, unit-tested `estimateRoutingSavings()` derives a downgrade savings
      **range** (low/high) from the live price-table ratio between a model's tier and
      the next-cheaper eligible tier **for that agent** — not a hardcoded constant.
- [ ] Rows below a configurable volume floor (min calls and/or min cost) are marked
      `lowConfidence: true` so UI can suppress or de-emphasize them.
- [ ] When the price table lacks an entry for a model, the row is returned with
      `savings: null` (never a fabricated number), and this path is unit-tested.
- [ ] Savings are computed per `agent_type`; a Claude Opus→Sonnet ratio is never
      applied to another agent's models.
- [ ] Unit tests cover: normal downgrade range, missing-price-entry null, low-volume
      suppression, and multi-agent isolation.

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
