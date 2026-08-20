---
id: P10-006
title: Recommendation validation loop
phase: 10
workstream: E
status: cancelled
owner: null
depends_on: [P10-001, P10-003]
blocks: []
estimate: M
---

## Goal

Close the loop on the effectiveness caveat: after a team adopts a routing change,
compare **projected** savings against **realized** spend for the following period, so
the recommendation surface stays honest and can be trusted over time.

## Context

See [`P10-roadmap.md`](./P10-roadmap.md) and `DESIGN_DOC.md` §10.6. A recommendation
surface that never checks itself drifts into vanity — exactly what §10.5 warns
against. This task adds a "did it work?" panel that measures whether recommended
downgrades actually reduced spend without a matching rise in friction/rework, mirroring
the Phase 7/HITL discipline of validating a computed signal against reality.

## Acceptance criteria

- [ ] When `P10-001`/`P10-003` emit a recommendation, the projection (task type,
      target tier, projected range, baseline spend, timestamp) is persisted so it can be
      compared later.
- [ ] A validation panel (on `/org/models`, org-admin scope) shows, for prior
      recommendations, the projected range vs the realized spend delta for the same
      task-type segment in the subsequent period.
- [ ] Realized delta pairs cost change with an outcome guard: it flags if a downgrade
      coincided with a **rise** in friction, tool-error, or revert rate for that segment,
      so a "saving" that degraded outcomes is surfaced, not celebrated.
- [ ] Segments with insufficient post-change volume are shown as "not yet
      measurable," never as a spurious delta.
- [ ] The projection→realization comparison is a pure, unit-tested function over
      persisted projections + post-period aggregates.

## Implementation notes

- Persist projections in a small `routing_recommendation` table (or reuse a generic
  events/audit-adjacent store) keyed by `(agent_type, tool_category, target_tier,
  created_at)`.
- Realized spend and outcome deltas reuse `P10-001` and the existing friction/rollup
  queries; replay projections against the price table active at projection time so the
  comparison is apples-to-apples.
- This is analysis + a panel — no scheduler work required; compute on read.

## Files touched

- `packages/db/prisma/schema.prisma` (projection store)
- `apps/web/src/lib/routing-analysis.ts` (validation function + test)
- `apps/web/src/app/org/models/page.tsx` (validation panel)

## Out of scope

- Auto-tuning recommendations from realized results (a future ML/heuristic loop).
- Team/individual validation surfaces — org-level is enough to prove the loop.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/web' test routing-analysis
bun run --cwd apps/web typecheck
```

## Cancelled 2026-08-18 — superseded by P13-006

Owner decision, taken while reconciling Phase 10. All five acceptance criteria are
satisfied, but by [`P13-006`](./P13-006-projection-validation-pattern.md) rather than
by this task's own design, so `cancelled` records what happened where `done` would
imply this spec was built.

The mapping, verified against the code:

| This task asked for | P13-006 provides |
|---|---|
| the projection persisted for later comparison | the `Projection` model — `claimType`, `segment`, `projectedLow`/`projectedHigh`, `unit`, baseline and window |
| a validation panel on `/org/models`, org-admin scope | the realization panels in `projection-queries.ts`, rendered on that page |
| an outcome guard flagging a saving that degraded outcomes | `outcomeFlagged`, computed from `frictionMean` / `revertRate` / `toolErrorRate` movement |
| "not yet measurable" instead of a spurious delta | `realizeProjection` returns `not_yet_measurable` below `minPostPeriodVolume` |
| a pure, unit-tested projection→realization function | `realizeProjection`, pure over persisted claims + post-period aggregates |

The difference that made it worth generalizing: P13-006 registers claims of any kind,
so the routing recommendation is one registered claim rather than the only thing the
mechanism knows how to check. `routingSavingRange` exists precisely to register the
routing claim as a **range** — a single number there would have been an assertion the
data cannot support.

An earlier revision of the Phase 13 branch marked this `cancelled` unilaterally, then
withdrew the claim because it had been written when Phase 10 read `ready`. This is
that decision taken properly, with Phase 10's state reconciled at the same time.
