---
id: P13-010
title: Judge calibration + drift alerting
phase: 13
workstream: D
status: blocked
owner: null
depends_on: [P13-005, P13-007, P13-009]
blocks: [P13-011]
estimate: M
---

## Goal

The job that keeps the judge honest: compare judge output against the P13-007 gold set
and against real outcomes on a schedule, publish the agreement figures on the P13-006
validation surface, and alert through the Phase 9 engine when the judge drifts.

## Blocker

Blocked on **DP-1** (see [`P13-roadmap.md`](./P13-roadmap.md)) and on
[`P13-007`](./P13-007-scorer-calibration-analysis.md): there is no gold set to
calibrate against until real labelled sessions exist. The runner itself
([`P13-009`](./P13-009-judge-runner-guardrails.md)) is buildable now; this is the part
that needs a corpus.

Note the ordering constraint that makes this task non-optional rather than a
nice-to-have: **a judge without a calibration loop is theatre.** If the judge is armed
([`P13-011`](./P13-011-arm-judge-for-other-users.md)) and this is not, the phase has shipped a confident number that nothing checks — the
precise failure the phase was created to fix, reintroduced at higher cost. The two
tasks are one decision.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§1.2 and §3.4 (R8). The 2026 consensus on judges is that calibration is a *loop*, not
a launch step: label a representative set, run the judge, review disagreements, revise
the criteria and examples, re-run on the same set **and a holdout**, and recalibrate
whenever the judge model, the judge prompt, or the system under test changes.

This platform has an advantage most judge pipelines lack: the judge can be checked
against **outcomes** as well as against hand labels — merged, reverted, CI-failed,
review-churned. A judge that says "task completed" on sessions whose PRs get reverted
is measurably wrong, without anyone labelling anything.

## Acceptance criteria

- [ ] A scheduled job computes, per judge `scorer_version`: agreement with the
      P13-005 gold set (accuracy / confusion matrix for categorical dimensions,
      correlation for numeric ones) and agreement with outcome labels.
- [ ] A **holdout** portion of the gold set is never used for prompt iteration and is
      reported separately, so tuning against the calibration set is visible as the
      overfit it is.
- [ ] Known judge biases are probed, not assumed absent: at minimum a position/order
      check and a verbosity check, reported as part of the calibration output.
- [ ] Recalibration is triggered — and visibly flagged as pending — whenever the judge
      model or prompt version changes. A judge running at an uncalibrated version is
      marked as such wherever its scores appear.
- [ ] Drift alerting is wired to the existing Phase 9 alert engine as its own rule
      type, aggregate-only with no individual identifiers, honoring silence/snooze and
      acknowledgement like every other rule.
- [ ] Calibration figures appear on the P13-008 scorer-validation surface alongside
      the heuristic scorers, so judge and heuristic are compared on one page under one
      standard.
- [ ] Judge scores are **not** consumed by any composite metric, recommendation, or
      alert until this job reports agreement above a stated, documented threshold —
      and the threshold is in the copy, not only in the code.
- [ ] Calibration runs use the frontier judge model reserved for audits; their
      `cost_usd` is recorded like any other score.

## Implementation notes

- Reuse `apps/web/src/lib/calibration.ts` from P13-007 for the statistics rather than
  writing a judge-specific second implementation — the whole point is that judge and
  heuristic are held to the same standard.
- The alert rule shape follows P9-001's existing rule types; do not build a parallel
  evaluation path.
- Report disagreements, not just aggregate agreement. The disagreement set is the
  material for the next rubric revision, and is the only artifact that makes the loop
  actually iterate.
- Sampling matters here too: calibration over the gold set is bounded, but
  outcome-agreement runs over the judged population and should reuse P13-009's
  sampling rather than scoring everything again.

- **Consider promptfoo rather than hand-rolling the agreement harness.** This
  task is "run the judge against a gold set and measure agreement", which is a
  dev/CI eval-harness problem — the shape promptfoo is built for, unlike the
  runtime client in [`P13-009`](./P13-009-judge-runner-guardrails.md). It is
  open source, Node-native, supports Anthropic, and runs evals entirely locally,
  so the consent model this phase rests on survives. Evaluate it when DP-1
  unblocks the task; the assessment that surfaced it is
  [`docs/research/2026-08-18-judge-client-provider-abstraction.md`](../docs/research/2026-08-18-judge-client-provider-abstraction.md) §2.4.
- **A second provider is the strongest reason to revisit provider abstraction.**
  If the judge is Claude and the sessions are largely Claude Code, agreement
  against a human gold set is one model checking itself. An independent judge on
  a different provider gives inter-rater agreement *across* models, which is a
  materially stronger calibration signal. The shape is a second class
  implementing `JudgeModelClient` plus a **`provider` field on `JudgeRevision`** —
  if the provider changes, the scorer's identity changes, and `scorerVersion`
  must capture it or two providers' verdicts blend into one series.

## Files touched

- `apps/ingest/src/jobs/calibrate-judge.ts` (+ test), `apps/ingest/src/jobs/scheduler.ts`
- `packages/schemas/src/alerts.ts` (drift rule type)
- `apps/web/src/lib/calibration.ts`
- `apps/web/src/app/org/quality/page.tsx` (judge rows on the validation surface)

## Out of scope

- Automatically rolling back or disabling a judge on drift. Alert and flag; a human
  decides.
- Auto-tuning the judge prompt from disagreements. The loop is human-in-the-loop by
  design — an automated prompt optimizer tuning against a gold set is an overfitting
  machine.
- Calibrating the heuristic scorers, which is P13-007's job. This task calibrates the
  judge and reuses that machinery.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/ingest' test calibrate-judge
bun --filter '@ai-agents-observability/web' test calibration
bun run check
bun run typecheck
bun run build
bun run test
```
