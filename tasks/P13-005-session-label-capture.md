---
id: P13-005
title: Session label capture (versioned rubric)
phase: 13
workstream: C
status: review
owner: claude
depends_on: [P13-001]
blocks: [P13-007, P13-010]
estimate: M
---

## Goal

Extend `SessionFeedback` from a bare sentiment into a small **versioned rubric** — which
shape best describes this session, and did it accomplish what you wanted — so that a
developer's own judgement of their session is captured as a first-class human label
from the moment the platform is in use.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§3.4 (R2). This task is the half of the original gold-set work that **pays off
regardless of whether a rollout happens**, which is why it is `ready` while the
analysis that consumes it ([`P13-007`](./P13-007-scorer-calibration-analysis.md)) is
blocked on the DP-1 data precondition.

The reasoning is timing. Labels can only be collected *while* sessions happen. If the
capture path does not exist before rollout, then whenever someone finally wants to
calibrate `friction_score`, the gold set starts at zero and has to be assembled
retrospectively — by a researcher reading other people's transcripts under access
grants, which is slower, more biased, and far more politically expensive than the
session owner answering two questions about their own work.

**This is product, not instrumentation.** A developer rating their own session is a
feature: it gives them a record of what worked, and it feeds the friction
decomposition already on `/me/insights`. `OPPORTUNITIES.md` §5's rule — *every new
analysis surface must first answer "what does the individual developer get from
this?"* — is satisfied directly rather than argued around.

Today `SessionFeedback` stores `sentiment` + an optional `note`, unique per
`(sessionId, userId)`, written from the session-detail page (added post-HITL, R11).
The seed script creates 24 such rows.

## Acceptance criteria

- [x] The rubric captures a self-reported session shape (the same four values as
      `shape_label`, plus an explicit "none of these") and a task-outcome judgement
      (`yes` / `partly` / `no`), against a **rubric version**.
      *Landed differently from the wording above:* only `rubric_version` is a
      `SessionFeedback` column. The two answers are `scores` rows
      (`human_session_shape` / `human_task_outcome`), not columns — they were
      briefly both, and a dual write to two stores is a divergence waiting for its
      first failed request. `rubric_version` stays on the row because no score row
      can express it: "answered version 1 and declined both questions" and
      "predates the rubric" are different facts, and an absent score row cannot
      tell them apart.
- [x] All fields are optional. A developer can still leave a bare thumbs-up, and the
      existing capture path keeps working unchanged.
- [x] Existing `SessionFeedback` rows remain valid and are readable as
      "rubric version 0" — no destructive migration.
- [x] Labels are written as `scores` rows (`source: human`) via P13-001, carrying the
      rubric version as `scorer_version`, so the analysis in P13-007 reads one table.
- [x] The capture UI is on the **session owner's own** session-detail page only. No
      path exists for anyone to label someone else's session in this task.
- [x] Nothing about the rubric response is visible to a team lead or org admin — not
      as a value, not as an aggregate. P13-007/P13-008 decide what, if anything, is
      ever aggregated; this task ships capture only.
- [x] The rubric is defined once in `packages/schemas` and versioned there, so a later
      wording change is a version bump rather than a silent redefinition that
      invalidates prior labels without anyone noticing.
- [x] Prompt copy does not lead the witness: the shape question must not show the
      computed `shape_label`, and the outcome question must not show
      `friction_score`, or the labels become a measure of the scorer rather than an
      independent check of it. This is verified in the UI, not just intended.
- [x] Seed data produces rubric-labelled sessions across shapes and outcome values so
      the downstream surfaces can be developed against something. Verified on a virgin
      database with `bun run db:seed:extensive`: 15 `session_feedback` rows, 11 of them
      answering rubric v1, and 22 `HUMAN` score rows. Note the governance fixtures
      (feedback, audit log, access grants, deletion requests) live in the **extensive**
      seed path only — the default `bun run db:seed` does not create them, which is
      pre-existing placement, not a defect.

## Implementation notes

- Keep the rubric **small**. Two questions is the target; the temptation to add a
  five-dimension quality scale should be resisted, since every added dimension is
  another thing to calibrate and another reason for a developer not to answer.
- Blinding the questions from the computed values is the single most important design
  detail and the easiest to lose in a later UI refactor — leave a comment saying why.
- Consider prompting at most once per session and never nagging; a label that people
  resent giving is a label that is noise.
- `sentiment` stays as-is. It is a distinct signal (how did this feel) from the
  outcome judgement (did it work), and collapsing them loses the more interesting of
  the two.
- Deletion and retention follow the session, as they already do for `SessionFeedback`.

## Files touched

- `packages/db/prisma/schema.prisma` (`SessionFeedback.rubricVersion`, nullable
  `sentiment`) — a Prisma migration, not a `sql/migrations/` file; see the record below
- `packages/schemas/src/rubric.ts` (+ test) — versioned rubric definition
- `apps/web/src/app/me/sessions/[id]/page.tsx` + the feedback component/action
- `packages/db/src/seed.ts`

## Out of scope

- Any analysis of the labels. That is P13-007, blocked on DP-1.
- Aggregating rubric responses to team or org surfaces.
- Researcher/grant-based labelling of other people's sessions. If it is ever needed,
  it is a separate task with its own trust review — owner self-labelling is the
  cheaper and safer source and should be exhausted first.
- Changing `friction_score` or `shape_label` in response to labels.

## Verification

```bash
bun install
bun run --cwd packages/db typecheck
bun --filter '@ai-agents-observability/schemas' test rubric
bun --filter '@ai-agents-observability/web' test
bun run check
bun run typecheck
bun run build
bun run test
```

## Implementation record

Landed. Notes for a reviewer:

- The `SessionFeedback` change is a **Prisma** migration — it landed as
  `20260812140000_session_rubric_and_projections/` and now lives inside the squashed
  `20260814000000_init/` — not the `sql/migrations/00NN_…` file this task's
  "Files touched" originally guessed at:
  `session_feedback` is a Prisma-managed table, and patching one of those from
  the custom-SQL layer produces a schema Prisma can no longer regenerate
  (`packages/db/AGENTS.md`).
- `sentiment` became **nullable** in the same migration. It gated the whole row
  before, so a developer who answered the rubric and then cleared their thumbs
  would have had the label deleted underneath them. Existing values are
  untouched.
- Rubric answers live in `scores` as `human_session_shape` /
  `human_task_outcome` (`source: HUMAN`, `scorer_version` = rubric version).
  Session-scoped score rows are already cleaned up by the deletion runner, so
  deletion and retention follow the session as required.
- **Correction (follow-up cleanup).** Those answers were originally written
  *twice* — to `scores` and to `session_feedback.shape_label` /
  `.task_outcome` — in two independent awaits. A failure between them left the
  developer's label in one store and not the other, and P13-007's calibration
  reads `scores`, the one that loses. The duplicate columns were dropped
  (`20260813100000_drop_session_feedback_rubric_answers`, which copies any
  diverged answer across before dropping), the form now prefills from `scores`,
  and the feedback row plus the score rows are written in one `$transaction`.
  `rubric_version` stays on `session_feedback`: it is not duplicated anywhere,
  and an absent score row cannot distinguish "declined to answer v1" from
  "predates the rubric".
- Blinding is enforced by `apps/web/test/session-rubric.test.ts`, which scans the
  capture card and its mount site rather than trusting review.
