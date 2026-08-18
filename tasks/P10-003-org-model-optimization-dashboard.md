---
id: P10-003
title: Org model optimization dashboard
phase: 10
workstream: E
status: done
owner: claude
depends_on: [P10-001, P10-002]
blocks: [P10-006]
estimate: M
---

## Goal

Replace the single heuristic "routing opportunities" card on `/org/models` with a
proper recommendations surface: savings segmented by task type and by team, expressed
as volume-gated ranges from the real price tables, alongside cache-efficiency
opportunities — each carrying the mandatory outcome caveat.

## Context

See [`P10-roadmap.md`](./P10-roadmap.md). The current card
(`computeRoutingInsights` in `apps/web/src/app/org/models/page.tsx`) flags premium
models where ≥10% of cost went to cheap categories and multiplies by a flat `0.8`.
This task swaps that inline heuristic for the `P10-001` layer and `P10-002` policy,
and expands it from one org number into an actionable, segmented surface.

`DESIGN_DOC.md` §10.6 is binding: every savings figure pairs with an outcome caveat,
and low-volume segments are suppressed, not shown with false precision.

## Acceptance criteria

- [x] `/org/models` shows routing recommendations grouped by `tool_category` (task
      type) **and** a per-team breakdown, each with a savings **range** (low/high) and
      the underlying monthly spend it's derived from.
- [x] All figures come from `P10-001` (price-table-derived) and `P10-002` (policy).
      Grepping the page for `DOWNGRADE_SAVINGS_RATE`, `PREMIUM_PATTERNS`, or
      `CHEAP_CATEGORIES` returns nothing — the constants are gone.
- [x] Segments below the volume floor are suppressed or shown as "insufficient data,"
      never as a point estimate.
- [x] A cache-efficiency opportunities section flags teams/models whose cache-read
      ratio is well below the target band, with the estimated cost of the gap.
- [x] Each recommendation renders the outcome caveat (a $40 session that unblocks work
      can beat a $5 reverted one) — enforced as a shared component, not ad-hoc copy.
- [x] Respects the time-range picker (`?range=`) and `viewer_aggregate` scoping (no
      individual sessions surfaced).

## Implementation notes

- Build from `@/components/ui` (`Stat`, `Card`, `Table`, `Badge`, `PageHeader`, the chart set)
  plus `DateRangePicker` from `team-org`. `StatCard`/`SectionCard`/`DataTable` were folded into
  those primitives — see [`apps/web/CLAUDE.md`](../apps/web/CLAUDE.md).
- Factor the caveat into a small shared `<EffectivenessCaveat/>` so P10-004 reuses it.
- Ranges: low = conservative (next-cheaper tier only, on clearly cheap categories);
  high = optimistic (full eligible spend). Label both.

## Files touched

- `apps/web/src/app/org/models/page.tsx`
- `apps/web/src/components/team-org/` (recommendation + caveat components)
- `apps/web/src/lib/routing-analysis.ts` (consume; extend if needed)

## As shipped

- The page's local constants are gone — grepping for `DOWNGRADE_SAVINGS_RATE`,
  `PREMIUM_PATTERNS` or `CHEAP_CATEGORIES` returns nothing. Tier, cheap-category
  and savings all resolve through the `P10-002` policy.
- Savings render as a **range** with the spread explained in the copy ("the spread
  is which model you route to, not uncertainty about the rates"), never a point
  estimate. Segments under the call/spend floor are suppressed entirely.
- Material retrieval spend on a model the price table cannot price is surfaced in
  its own "Unpriced models" card rather than silently dropped, so an empty
  recommendations list means "efficient", never "we could not tell".
- The outcome caveat is carried by the shared `RoutingRecommendations` component
  and the validation panel below it, not restated per call site.

## Out of scope

- Team/individual surfaces (P10-004) and governance (P10-005).
- Realized-vs-projected validation (P10-006).

## Verification

```bash
bun install
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
# Manual: seed extensive data, open /org/models, confirm segmented ranges + caveat,
# and that low-volume task types are suppressed.
```
