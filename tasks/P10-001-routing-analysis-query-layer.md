---
id: P10-001
title: Routing analysis query layer + defensible savings model
phase: 10
workstream: B
status: done
owner: claude
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

- [x] A query function returns cost + token + call-count rollups grouped by
      `agent_type`, `model`, `tool_category`, and `shape_label` over a date range,
      scoped to the caller's visibility (org-visible users only for org callers).
- [x] A pure, unit-tested `estimateRoutingSavings()` derives a downgrade savings
      **range** (low/high) from the live price-table ratio between a model's tier and
      the next-cheaper eligible tier **for that agent** — not a hardcoded constant.
- [x] Rows below a configurable volume floor (min calls and/or min cost) are marked
      `lowConfidence: true` so UI can suppress or de-emphasize them.
- [x] When the price table lacks an entry for a model, the row is returned with
      `savings: null` (never a fabricated number), and this path is unit-tested.
- [x] Savings are computed per `agent_type`; a Claude Opus→Sonnet ratio is never
      applied to another agent's models.
- [x] Unit tests cover: normal downgrade range, missing-price-entry null, low-volume
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

## As shipped

- The savings model lives in [`packages/schemas/src/model-policy.ts`](../packages/schemas/src/model-policy.ts)
  so `apps/ingest` can read it too — `apps/web` and `apps/ingest` cannot import
  each other, and the previous arrangement had "premium" defined twice.
- `estimateRoutingSavings()` returns a **range** (`low`/`high`) or `null`, never a
  point estimate and never a fabricated number. `high` assumes the cheapest model
  in the target tier, `low` the dearest; when the tier holds one rate the range
  legitimately collapses to a point.
- Tiers are **derived by ranking distinct blended rates** within one agent's price
  table, not by an absolute threshold or a multiple of the cheapest model. Both
  alternatives fail on the real data: the cheapest-to-dearest spread is ~19x for
  `claude_code` but ~8000x for `opencode`, whose table `P12-012` regenerated from
  the models.dev catalog across 20 vendors.
- `getOrgModelRoutingBreakdown` now groups by `agent_type`, so one agent's price
  ratio can never reach another agent's models. `shape_label` from the original
  criteria was **not** added: nothing consumes it, and putting it in the `GROUP BY`
  splintered each cell into one row per shape, duplicating `topCategories`.
- Low-volume rows are **suppressed** rather than flagged `lowConfidence` — the
  surviving rows carry a `high`/`medium` `confidence`. The user-visible outcome the
  criterion asked for (never a point estimate off a thin sample) holds.

## Known limitations

- **Retired models can be named as the downgrade target.** The price tables retain
  retired rows on purpose (historical cost recompute needs them), so the cheapest
  economy-tier model for `claude_code` is a 2024 Haiku. `model-policy-golden.test.ts`
  pins this deliberately so the fix is a visible diff. The real fix is a
  deprecation flag on price-table rows.
- **Current Opus tiers as `standard`, not `premium`,** for the same reason: the
  retired `$15/$75` rows occupy the top band. Recommendations still fire for it
  (economy is cheaper), so this is a labelling artifact, and it is what the admin
  tier override exists to correct.

## Out of scope

- Any UI. This task is query + derivation + tests only (consumed by P10-003/004).
- The policy/config source (P10-002) — accept an injected tier resolver for now.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/web' test routing-analysis
bun run --cwd apps/web typecheck
```
