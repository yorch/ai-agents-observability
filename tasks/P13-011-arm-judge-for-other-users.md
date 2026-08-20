---
id: P13-011
title: Arm the judge for other users' transcripts
phase: 13
workstream: D
status: blocked
owner: null
depends_on: [P13-007, P13-009, P13-010]
blocks: []
estimate: S
---

## Goal

The irreversible step, deliberately isolated as its own small task with its own
decision: remove the own-sessions-only restriction from the judge runner so it scores
sessions belonging to **other people who have consented**, and expose the resulting
aggregates to team and org surfaces.

## Blocker

Two conditions, both required:

1. **DP-1 plus a calibrated judge.** [`P13-007`](./P13-007-scorer-calibration-analysis.md)
   must have produced a gold set, and [`P13-010`](./P13-010-judge-calibration-drift.md)
   must report judge agreement above the threshold it documents. An uncalibrated judge
   scoring other people's work is a confident number nothing can check — pointed at
   the one subject matter where being confidently wrong is most damaging.
2. **An explicit owner decision taken with developers consulted, in advance.**
   Not a retrospective announcement. `DESIGN_DOC.md` §8.2 calls the sharing defaults
   "the political fault line of the project," and
   [the assessment](../docs/research/2026-08-12-llm-evals-assessment.md) §4 names the
   surveillance failure mode as the existential risk. §6 Q5 poses the question that
   should be asked of actual developers before this ships: *would per-session judge
   output visible only to you still feel like surveillance?* The HITL work is the
   precedent — it grounded its dashboards in permission-mode data and stated findings
   before designing the surfaces.

The task is small on purpose. Isolating a one-line capability change behind its own
decision is the point: it means the decision is visible, dated, and attributable
rather than folded into a large task where it becomes an implementation detail.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) (workstream D posture) and
[`P13-009`](./P13-009-judge-runner-guardrails.md), which built the runner with the
own-sessions restriction as a second guard *in addition to* the consent check,
specifically so this change is a deliberate act rather than a side effect.

## Acceptance criteria

- [ ] The own-sessions config guard is removed; the `VisibilityPolicy` consent check
      remains the sole gate and is unchanged, still evaluated at both selection and
      fetch.
- [ ] A session whose owner has not opted in is still never fetched. The test that
      proves this predates this task and must still pass unmodified.
- [ ] Per-session judge output remains visible **only to the session owner**. Team and
      org surfaces receive aggregates only, with small-n suppression matching the
      existing effectiveness distributions.
- [ ] No surface ranks developers by judge output, and no per-developer judge score is
      reachable by a team lead or org admin through any path, including search facets
      and exports.
- [ ] Judge scores appear on the P13-008 validation surface held to the same standard
      as the heuristic scorers, with the calibration figure attached.
- [ ] The runner refuses to score if P13-010 reports the active `scorer_version` as
      uncalibrated or drifted — the calibration gate is enforced in code, not by
      convention.
- [ ] The decision itself is recorded: a dated note in the task file or a `docs/`
      entry stating who decided, when, what developers were told, and what they said.
      An undocumented decision here is indistinguishable from no decision.

## Implementation notes

- Resist widening scope while touching this. The temptation will be to add the team
  aggregate view, the export, and the search facet in the same change; each of those
  is a separate exposure decision and deserves to be visible as one.
- If developer consultation surfaces objections, the correct outcome may be to
  `cancel` this task and keep the judge as an owner-only feature permanently. That is
  a legitimate end state, not a failure — the runner still earns its keep as a
  self-service insight for the person whose session it is.

## Files touched

- `apps/ingest/src/config.ts`, `apps/ingest/src/jobs/judge-sessions.ts`
- team + org aggregate surfaces (suppressed aggregates only)
- `apps/web/src/app/org/quality/page.tsx` (judge rows on the validation surface)

## Out of scope

- Loosening the `VisibilityPolicy` consent requirement in any way.
- Any per-developer judge score visible to anyone but that developer.
- Feeding judge output into `friction_score`, recommendations, or alerts. Still
  excluded; that would be a further task with its own review.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/ingest' test judge-sessions
bun --filter '@ai-agents-observability/web' test
bun run check
bun run typecheck
bun run build
bun run test
```
