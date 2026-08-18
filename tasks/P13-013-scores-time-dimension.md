---
id: P13-013
title: Time dimension on the scores unique key
phase: 13
workstream: A
status: ready
owner: null
depends_on: [P13-001, P13-004]
blocks: []
estimate: M
---

## Goal

Let a scorer produce a value **per period** rather than one value per subject
forever, so subject scores can carry a trend instead of a single current number.

## Context

[`P13-001`](./P13-001-scores-substrate.md) keys `scores` on
`(subject_type, subject_id, scorer_name, scorer_version)`. That is exactly right
for a session — a session happened once, so it has one friction score, and the
upsert on that key is what makes re-running a scorer free.

It is wrong for a subject that persists. A skill or an MCP server
([`P13-004`](./P13-004-skill-mcp-effectiveness.md)) is scored over a *window*, and
each nightly run of `compute-subject-scores` overwrites the last. The row is
always "as of the most recent run", with no history behind it.

`compute-subject-scores` therefore cannot produce the trend its own docstring
describes, and `/org/skills` and `/org/mcp` can only ever show a current value.
This was known when `P13-004` shipped and left alone deliberately: it is a schema
change with two consumers that are written but not yet started
([`P13-007`](./P13-007-scorer-calibration-analysis.md),
[`P13-008`](./P13-008-scorer-validation-surface.md)), and bundling it into a
cleanup pass would have committed those consumers to a shape nobody had thought
about yet.

The cost of waiting is bounded and known: subject scores accumulate no history
until this lands, so a trend built afterwards starts from the change date rather
than from today.

## Acceptance criteria

- [ ] The unique key admits a period for subjects that need one, without forcing a
      period onto subjects that don't. A session's score must not require an
      invented window — "this session, once" and "this skill, in this week" are
      different facts and the key should be able to say both.
- [ ] `compute-subject-scores` writes one row per subject **per period**, and
      re-running it for a period that already has a row is still idempotent.
- [ ] Existing rows survive the migration and remain readable. Rows written before
      the change are unambiguously distinguishable from a period-scoped row — an
      absent period must not be silently read as "the current period."
- [ ] `/org/skills` and `/org/mcp` show a trend rather than a single current value,
      with the same volume gating and small-n suppression the panel already applies.
      A trend built from two points is not a trend and must not render as one.
- [ ] The `scores` read paths in `P13-007`'s calibration analysis are written
      against the new key from the start, not adapted afterwards.
- [ ] Prisma models the change. **Read [`packages/db/AGENTS.md`](../packages/db/AGENTS.md)
      first** — this is a Prisma-managed table, so it is a relational migration, and
      patching it from the custom-SQL layer would produce a schema Prisma can no
      longer regenerate.

## Implementation notes

- Decide the period representation before writing any migration: a nullable
  `period_start`/`period_end` pair on the existing key, versus a separate
  subject-score table, versus a `period` column defaulting to a sentinel. The first
  keeps one table and one read path; the third makes the "no period" case
  indistinguishable from a real one, which the third acceptance criterion forbids.
- Whatever is chosen, the deletion runner must still remove every session-scoped
  row for a deleted session. `scores` carries no FK — the subject is heterogeneous —
  so that cleanup is explicit code, and a new key shape can silently miss rows.
- Bumping a scorer version and re-running is the established way to re-score
  history (`rescore-effectiveness` / `rescore-trajectory`). Check whether a period
  dimension changes what those jobs should select on.

## Out of scope

- New scorers. This changes how scores are keyed, not what is computed.
- Backfilling history for periods that were never scored. There is no data to
  recover — the overwrites already happened.

## Verification

```bash
bun run --cwd packages/db typecheck
bun run check
bun run typecheck
bun run build
bun run test
```
