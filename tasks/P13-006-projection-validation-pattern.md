---
id: P13-006
title: Projection registry + realization (generalizes P10-006)
phase: 13
workstream: C
status: done
owner: claude
depends_on: [P13-001]
blocks: []
estimate: M
---

## Goal

Make every predictive claim the product makes checkable: any surface that says "you
could save X" or "do Y and friction drops" persists its projection, and a shared
mechanism later reports realized-vs-projected with an outcome guard.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§3.4 (R5). [`P10-006`](./P10-006-recommendation-validation-loop.md) already specifies
exactly this for routing recommendations, including the crucial detail that a
"saving" coinciding with a rise in friction or reverts must be surfaced rather than
celebrated. The pattern is worth more than the instance: the product makes predictive
claims in at least three places today —

- `/org/models` routing recommendations ("you could save X by routing retrieval-only
  work to a cheaper tier"),
- `/me/insights` coaching recommendations (`apps/web/src/lib/recommendations.ts` —
  pre-approve denied tools, investigate error-prone tools, tighten prompts),
- `/org/dashboard` spend forecasting (trailing run-rate → month-end projection),

and **none of them ever checks itself.** `DESIGN_DOC.md` §10.5 warns against vanity
metrics; an unchecked recommendation surface is how a product drifts into being one.

This task subsumes P10-006: implementing the general mechanism here and applying it to
routing satisfies P10-006's acceptance criteria, and P10-006 should be marked
superseded rather than built twice.

## Acceptance criteria

- [x] A shared projection store records, for any claim: the claim type, the subject
      and segment it applies to, the projected quantity (as a **range**, not a point
      estimate), the baseline it was measured from, the price table or scorer version
      active at projection time, and the timestamp.
- [x] A shared realization function compares a stored projection against the
      subsequent period's actuals, replaying against the versions active at projection
      time so the comparison is apples-to-apples.
- [x] Every realization carries an **outcome guard**: a "win" that coincided with a
      rise in friction, tool-error rate, or revert rate for that segment is flagged,
      not celebrated.
- [x] Segments with insufficient post-period volume render as "not yet measurable,"
      never as a spurious delta.
- [x] Applied to at least the `/org/models` routing recommendations, which is what
      P10-006 asks for.
- [x] P10-006 is marked `cancelled` (superseded) in `INDEX.md`. *Withdrawn once and
      then settled properly. This branch originally asserted it unilaterally, which
      was wrong — the claim was written when Phase 10 read `ready` while the trunk
      read `done`, and Phase 10's own state was self-inconsistent besides. Taken as
      an owner decision on 2026-08-18 alongside the rest of the Phase 10
      reconciliation, with the criterion-by-criterion mapping recorded in
      [`P10-006`](./P10-006-recommendation-validation-loop.md).*
- [x] The forecast on `/org/dashboard` records its projection and later shows
      projected-vs-actual for the closed month.
- [x] The comparison is a pure, unit-tested function over
      (stored projections, post-period aggregates).
- [x] No claim surface ships a new prediction without registering a projection —
      enforced by the API shape (the function that renders a claim is the function
      that records it), not by a code-review convention.

## Implementation notes

- The projection store can be `scores` rows with `source: heuristic` and a
  `subject_type` of the segment, or a small dedicated table. Prefer reusing `scores`
  if the shape fits — one fewer place for provenance to go missing — but do not
  contort it: a projection has a *target period* that a score does not.
- Ranges, not point estimates, throughout. P10-001 already establishes range-based
  savings with volume/confidence gating; the same discipline applies here.
- The individual-coaching claims on `/me/insights` are the delicate case: measuring
  "did this developer follow the advice and did it work" is close to the surveillance
  line. Restrict per-individual realization to the **owner's own view**, and report
  coaching effectiveness above that level only as an aggregate over the recommendation
  type, never over people.
- Reuse `apps/web/src/lib/routing-queries.ts` for the routing instance rather than
  duplicating the savings model.

## Files touched

- `packages/db/prisma/schema.prisma` (projection store, if not `scores`)
- `apps/web/src/lib/projections.ts` (+ test)
- `apps/web/src/lib/routing-queries.ts`, `apps/web/src/app/org/models/page.tsx`
- `apps/web/src/app/org/dashboard/page.tsx`
- `tasks/INDEX.md`, `tasks/P10-006-recommendation-validation-loop.md` (supersession)

## Out of scope

- Auto-tuning recommendations from realized results (P10-006 already excludes this;
  it stays excluded).
- Retroactively validating claims made before the projection store existed — there is
  no record to check against, and inventing one is worse than admitting the gap.
- Per-individual coaching-effectiveness reporting to anyone but the individual.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/web' test projections
bun --filter '@ai-agents-observability/web' test routing-queries
bun run --cwd apps/web typecheck
bun run check
bun run typecheck
bun run build
bun run test
```

## Implementation record

Landed. Notes for a reviewer:

- A dedicated `projections` table, not `scores` rows: a projection has a target
  period, and `scores` has nowhere to put one — reusing it would have meant
  smuggling `period_start`/`period_end` through `metadata` where nothing could
  index or constrain them. The task explicitly permits this.
- "Rendering is recording" is enforced by a **branded type**:
  `RegisteredProjection` carries a `unique symbol` declared privately in
  `projections.ts`, and only `recordProjection(s)` (which persist) return one.
  `RoutingRecommendations` and `SpendForecast` take that type, so displaying an
  unrecorded claim is a type error rather than a review finding.
- The "Routing opportunities" banner on `/org/models` was **removed** rather
  than registered: it made the same claim as the recommendations below it, from
  a hardcoded 0.8 savings rate and as a single number.
- Per-individual coaching realization on `/me/insights` was **not** built. The
  registry supports it, but the task flags it as the delicate case, and nothing
  in the acceptance criteria requires it — see "Not done" below.
- The outcome guard is measured at **org level**, not per segment. A session
  touches several models and routing is an org-wide config decision, so a
  per-model attribution of "did outcomes get worse" would look more precise than
  it is.

### Not done

- `/me/insights` coaching claims are not registered. They are per-individual and
  measuring "did this developer take the advice" is the surveillance-adjacent
  case the task asks to restrict to the owner's own view; it deserves its own
  task rather than being tacked on here.
