---
id: P10-003
title: Org model optimization dashboard
phase: 10
workstream: E
status: in-progress
owner: null
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

*Audited against the code 2026-08-18 (see the implementation record).*

- [x] `/org/models` shows routing recommendations grouped by `tool_category` (task
      type) **and** a per-team breakdown, each with a savings **range** (low/high) and
      the underlying monthly spend it's derived from. *`RoutingRecommendations` renders
      `topCategories` with `routingSavingRange`; `RoutingByTeam` renders the per-team
      cut from `getRoutingSpendByTeam`.*
- [ ] **Fails literally.** All figures come from `P10-001` (price-table-derived) and `P10-002` (policy).
      Grepping the page for `DOWNGRADE_SAVINGS_RATE`, `PREMIUM_PATTERNS`, or
      `CHEAP_CATEGORIES` returns nothing — the constants are gone. *`page.tsx:31` is
      still `const PREMIUM_PATTERNS = ['opus'];`, and `routing-queries.ts` holds
      `PREMIUM_PATTERN`, `CHEAP_SUITABLE_CATEGORIES` and `HAIKU_SAVINGS_RATIO`. The
      constants were renamed and relocated, not eliminated — they cannot be eliminated
      until `P10-002` supplies the policy that replaces them.*
- [ ] Segments below the volume floor are suppressed or shown as "insufficient data,"
      never as a point estimate. *No volume floor exists (`P10-001`, criterion 3).
      Note the P13-006 realization panel does gate on `minPostPeriodVolume` and shows
      `not_yet_measurable` — but that gates the **realized** number, not the
      projection this criterion is about.*
- [ ] **Partial.** A cache-efficiency opportunities section flags teams/models whose cache-read
      ratio is well below the target band, with the estimated cost of the gap.
      *Per-**model** cache efficiency is band-coloured via `cacheEfficiencyClass`
      (good ≥0.4, warn ≥0.2, crit below) and there is an org-level
      `estimatedCacheSavings`. Missing: any per-**team** flagging, and a per-row cost
      of the gap.*
- [ ] Each recommendation renders the outcome caveat (a $40 session that unblocks work
      can beat a $5 reverted one) — enforced as a shared component, not ad-hoc copy.
      *No `EffectivenessCaveat` component exists. What did land instead is stronger in
      one respect and does not substitute in another: P13-006's outcome guard sets
      `outcomeFlagged` from real friction / revert / tool-error movement, so a
      degrading "saving" is flagged from data rather than from standing copy — but
      that only fires on realization, and an unrealized recommendation still renders
      with no caveat.*
- [x] Respects the time-range picker (`?range=`) and `viewer_aggregate` scoping (no
      individual sessions surfaced). *`searchParams.range` is validated to 7/30/90;
      all reads go through `orgVisibleUserIds`.*

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

## Implementation record — partial, reopened 2026-08-18

`INDEX.md` carried this as `done`; the file carried `ready`. Audited against the
code, it is neither — three of six criteria hold, so it is reopened as `in-progress`.

**The page is real and mostly does the job.** `/org/models` renders task-type
recommendations with low/high ranges, a per-team routing breakdown, per-model cache
efficiency, and honours `?range=` under `viewer_aggregate` scoping. The savings
banner this task set out to kill *was* removed — the comment at `page.tsx:58` records
that it made the same claim as the recommendations below it, from a hardcoded 0.8
rate and as a single number.

**But the central criterion fails on its own terms.** Criterion 2 is a grep, and the
grep finds `PREMIUM_PATTERNS` still declared in `page.tsx`. Renaming
`CHEAP_CATEGORIES` to `CHEAP_SUITABLE_CATEGORIES` and moving it into
`routing-queries.ts` is not what "the constants are gone" meant. This is not
fixable in isolation: the constants encode the model policy, and `P10-002` — the task
that would supply it from configuration — was never built. Closing this one as `done`
would have quietly retired that dependency.

**The caveat requirement was met by something else, only halfway.** No shared
`<EffectivenessCaveat/>` exists. P13-006's outcome guard is arguably better than the
standing copy this task asked for, because it flags a degrading saving from measured
friction / revert / tool-error movement rather than from a sentence. It does not
cover the same ground, though: it fires on realization, so a fresh recommendation
still renders uncaveated.
