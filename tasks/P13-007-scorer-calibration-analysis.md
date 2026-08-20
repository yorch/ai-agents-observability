---
id: P13-007
title: Scorer calibration analysis
phase: 13
workstream: C
status: blocked
owner: null
depends_on: [P13-001, P13-005]
blocks: [P13-008, P13-010, P13-011]
estimate: M
---

## Goal

Answer, with numbers: is `shape_label` accurate, and does `friction_score` predict
anything real? Publish the answer wherever the score is shown — or retire the score on
the evidence.

## Blocker

**Blocked on DP-1**, the data precondition defined once in
[`P13-roadmap.md`](./P13-roadmap.md): telemetry from ≥10 real users over ≥60 days,
≥200 human-labelled sessions stratified across shape and friction bands, and ≥100
outcome-linked PRs with revert and CI status resolved.

The corpus today is seed and dev data. Calibrating a scorer against generated fixtures
measures the fixture generator, not the scorer — and would produce a confident number
that is worse than no number, which is the exact failure this phase exists to prevent.
Below DP-1 a result is not merely weak; it is underpowered and reads as a verdict.

This task **unblocks itself** when the corpus arrives. Nobody needs to make a decision.
[`P13-005`](./P13-005-session-label-capture.md) ships now precisely so the labels are
accruing while this waits.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§2.3 and §3.4 (R2). This is the task that makes the phase honest.

`friction_score` and `shape_label` are rendered to three audiences, drive a search
facet, and drive the coaching recommendations in
`apps/web/src/lib/recommendations.ts` — and neither has ever been checked. Their
weights (`FRICTION_WEIGHTS` in `packages/schemas/src/effectiveness.ts`) are asserted.
`DESIGN_DOC.md` §10.6 warns that such metrics are "directionally useful and precisely
misleading" without outcome context.

Two label sources, and the analysis needs both:

1. **Human labels** — from `SessionFeedback`'s versioned rubric (P13-005), stored as
   `scores` rows with `source: human`.
2. **Outcome labels** — free, delayed, and objective: `pull_requests.merged_at` /
   `reverted_at`, `pr_ci_status`, `pr_review_decision`, `pr_check_runs`,
   `pr_rollups.check_failures_count`, and `jira_issues` defect linkage.

P11-004 already added Fisher's exact for friction-band deltas on `/org/quality` — that
is the statistical machinery this task reuses, not something to rebuild.

## Acceptance criteria

- [ ] A calibration report computes, from `scores` rows and outcome tables:
      - `shape_label` accuracy and a **confusion matrix** against the human rubric
      - `friction_score` relationship to each outcome (revert, CI failure, review
        churn, owner outcome judgement), each with a significance test **and an
        effect size**
      - inter-rater agreement wherever two humans labelled the same session
- [ ] The report is a **pure, unit-tested function** over (labels, scores, outcomes) —
      not a one-off script whose result cannot be regenerated.
- [ ] Every published figure carries its sample size and a confidence interval. A
      calibration on 200 sessions is an estimate with an interval, never "the
      accuracy."
- [ ] Results are stratified by repo and session shape where volume allows, because
      the dominant confounder is task difficulty: hard tasks produce both high friction
      and bad outcomes. Where stratification is not possible, the published copy says
      so.
- [ ] A **calibration figure is displayed next to the score** on `/me/insights` and
      wherever friction or shape reaches a team lead or org admin — including the
      honest negative case ("this score has not been shown to predict outcomes").
- [ ] If a scorer fails to predict anything, the deliverable is a written
      recommendation to retire or re-weight it, filed as a follow-up task — not a
      quiet pass.
- [ ] The analysis reads only `scores` rows and outcome tables. It does not read
      transcripts and requires no access grant.

## Implementation notes

- Practitioner guidance converges on 500+ labelled cases before trusting aggregate
  metrics; DP-1's 200 is the pragmatic floor for a first pass, and the criteria carry
  the caveat rather than pretending otherwise. Treat 500 as the target for a second
  iteration.
- Reuse `apps/web/src/lib/quality-queries.ts` for significance testing.
- Report the disagreement set, not only aggregate agreement — the sessions where the
  scorer and the human diverge are the material for any re-weighting, and are the only
  artifact that makes the loop iterate.
- The negative result is a real and valuable outcome. Budget for it; a task that can
  only "succeed" by confirming the scorer is not a calibration.

## Files touched

- `apps/web/src/lib/calibration.ts` (+ test) — the reproducible report
- `apps/web/src/lib/effectiveness-queries.ts`, `insights-queries.ts`
- `apps/web/src/app/me/insights/page.tsx`, team + org effectiveness surfaces

## Out of scope

- Collecting the labels. That is P13-005, which ships now.
- Changing the friction weights or the shape classifier in this task. Measure first;
  re-weighting is a follow-up informed by the result.
- Any LLM judge, including "use a judge to bootstrap the gold set." The gold set is
  what judges are measured against; generating it with a judge is circular.
- Publishing per-developer calibration. Calibration is a property of the scorer, not
  of a person.
- Approximating the analysis against seed data to "get started." See the blocker.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/web' test calibration
bun run --cwd apps/web typecheck
bun run check
bun run typecheck
bun run build
bun run test
```
