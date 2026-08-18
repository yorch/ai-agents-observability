---
id: P13-008
title: Scorer validation surface
phase: 13
workstream: C
status: blocked
owner: null
depends_on: [P13-001, P13-007]
blocks: []
estimate: M
---

## Goal

Generalize P11-004 from one metric into a framework: for **every** scorer in the
`scores` table, show its relationship to real outcomes over time, significance-tested,
so a scorer that has stopped predicting becomes visibly a scorer to retire.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§3.4 (R4). P11-004 added Fisher's exact significance testing on friction-band deltas
for `/org/quality` — the right idea applied to exactly one metric. Once P13-001 gives
every scorer a name and version and P13-003/P13-004 add more of them, the same
treatment generalizes: each scorer is a claim, and each claim can be checked against
`pull_requests` / `pr_check_runs` / `pr_reviews` / `jira_issues` outcomes.

The reason this matters beyond tidiness: scorer drift is invisible without it. A
heuristic tuned against 2026 usage patterns may stop predicting as agents, models, and
team practices change, and nothing in the product today would notice.

## Acceptance criteria

- [ ] An org-admin-scoped surface (extending `/org/quality`) lists every active
      scorer with, per scorer: current version, coverage (how many subjects scored),
      its measured relationship to each available outcome, the significance test
      result, and the trend of that relationship over time.
- [ ] A scorer whose relationship to outcomes has decayed below significance in the
      recent window is flagged as **stale** with the window shown — not silently
      dropped and not silently kept.
- [ ] Version changes are visible on the trend: when a scorer's `scorer_version`
      bumps, the surface shows the boundary rather than blending two scorers into one
      misleading line.
- [ ] All comparisons are volume-gated and small-n suppressed, and no panel exposes
      an individual's score. The subject of this page is the scorer, not any person.
- [ ] Copy states association, not causation, on every panel, and names the dominant
      confounder (task difficulty) at least once on the page.
- [ ] The comparison logic is a pure, unit-tested function over
      (scores, outcomes, window) reusing the existing Fisher's exact implementation
      rather than a second statistics path.
- [ ] Scorers with no outcome-linked subjects (e.g. sessions that never produced a PR)
      are reported as "not measurable" rather than as a null result.

## Implementation notes

- Extend `apps/web/src/lib/quality-queries.ts` rather than forking it; the P11-004
  Fisher's exact implementation is the shared primitive.
- The natural page is a new tab or section on `/org/quality`, which already carries
  the defect-attribution framing and the org-admin scoping.
- "Stale" needs a defined rule, not a vibe: e.g. no significant relationship in the
  last *N* days at a stated threshold, with *N* configurable. Put the rule in the copy
  so a reader can disagree with it.
- The calibration figures from P13-007 belong on this page too — accuracy against the
  gold set and predictiveness against outcomes are two views of "is this scorer any
  good," and splitting them across surfaces guarantees one gets forgotten.
- Consider wiring a stale-scorer condition into the Phase 9 alert engine as a
  follow-up rather than in this task; the surface is the deliverable here.

## Files touched

- `apps/web/src/lib/quality-queries.ts` (+ test)
- `apps/web/src/app/org/quality/page.tsx`

## Out of scope

- Automatically retiring or re-weighting a scorer. The surface reports; a human
  decides and files the change.
- Per-developer or per-team scorer breakdowns. Scorer quality is an org-level
  property.
- Alerting on scorer staleness (follow-up).
- Judge-specific validation — that is P13-010, which uses this surface but adds the
  drift-monitoring job.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/web' test quality-queries
bun run --cwd apps/web typecheck
bun run check
bun run typecheck
bun run build
bun run test
```
