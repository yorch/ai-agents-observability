---
id: P13-013
title: Time dimension on the scores unique key
phase: 13
workstream: A
status: review
owner: claude
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

- [x] The unique key admits a period for subjects that need one, without forcing a
      period onto subjects that don't. A session's score must not require an
      invented window — "this session, once" and "this skill, in this week" are
      different facts and the key should be able to say both.
- [x] `compute-subject-scores` writes one row per subject **per period**, and
      re-running it for a period that already has a row is still idempotent.
- [x] Existing rows survive the migration and remain readable. Rows written before
      the change are unambiguously distinguishable from a period-scoped row — an
      absent period must not be silently read as "the current period."
- [x] `/org/skills` and `/org/mcp` show a trend rather than a single current value,
      with the same volume gating and small-n suppression the panel already applies.
      A trend built from two points is not a trend and must not render as one.
- [ ] **Not yet — P13-007 is unstarted.** The `scores` read paths in `P13-007`'s calibration analysis are written
      against the new key from the start, not adapted afterwards.
- [x] Prisma models the change. **Read [`packages/db/AGENTS.md`](../packages/db/AGENTS.md)
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

## Implementation record

Landed 2026-08-18. The representation was an owner decision taken before any
migration was written, between one table with a nullable period, one table with
two partial indexes, and a separate `subject_scores` table. **One table, nullable
period, `NULLS NOT DISTINCT`.**

What that modifier buys, and why it is the whole design: Postgres treats every
NULL as distinct in a unique index by default, so a session score's NULL period
would not conflict with itself — two rows for the same session would both insert
and the idempotent upsert every scorer job depends on would quietly become an
append. `NULLS NOT DISTINCT` (Postgres 15+; the stack runs 18) makes one
statement serve both shapes.

Consequences, each deliberate:

- Prisma's schema language cannot express the modifier, so the unique index moved
  to `sql/migrations/0001_init.sql` — the same treatment
  `sessions_run_kind_idx` already gets. `test/scores-period-key.test.ts` reads
  that file as text and fails if it stops declaring it, because a dropped
  constraint here is invisible until duplicate rows appear.
- With no `@@unique` there is no generated compound-unique input, so
  `prisma.score.upsert` is gone. Both apps and the seed now write through one
  shared statement, `scoreUpsertSql()` in `packages/db` — previously the SQL
  existed twice.
- `SCORERS` entries declare `periodic`, and `buildScoreRow` throws in both
  directions: a periodic scorer with no period (every run overwrites the last —
  the bug this task exists to fix) and a one-shot scorer with one (a session's
  single score splits into a row per run). Neither would have surfaced as a
  failure; both produce a plausible-looking table.
- `trailingWindow()` truncates to the day. `period_start` is the row's identity,
  so an unbucketed `now()` would give every re-run its own row.

Verified against a live TimescaleDB instance rather than by inspection: two
NULL-period rows for one session collapse to one row with the value updated; two
different periods for one skill coexist; re-running the same period refreshes it.
Running `compute-subject-scores` twice produced 3 rows and 1 period both times;
backdating a day produced 6 rows and 2 periods.

The trend renders on `/org/skills`, `/org/mcp` and both team equivalents as a
sparkline gated at `SUBJECT_TREND_MIN_POINTS` (3). Below that the cell says how
many days it has rather than drawing a line: two points make a direction the data
does not support, the same reason the outcome comparison says "not yet
measurable" instead of greying out a number.
