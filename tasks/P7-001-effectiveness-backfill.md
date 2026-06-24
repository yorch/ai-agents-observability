---
id: P7-001
title: Effectiveness backfill (historical sessions)
phase: 7
workstream: B
status: review
owner: claude
depends_on: [P5-001, P5-002]
blocks: [P7-002, P7-006]
estimate: M
---

## Goal

Widen `compute-effectiveness` so it can backfill all historical sessions that lack
`friction_score` or `shape_label`, not just those updated in the last 48 hours.
The backfill runs as a one-shot admin job, is idempotent, and is batched to avoid
locking the `sessions` table.

## Context

The existing `runComputeEffectiveness()` in `apps/ingest/src/jobs/compute-effectiveness.ts`
gates its `WHERE` clause on `last_event_at >= NOW() - INTERVAL '48 hours'`. Sessions
older than that window have never been scored, so no effectiveness UI widget can show
meaningful coverage until this gap is closed. `DESIGN_DOC.md` §10.3 notes that signals
are "captured now, surfaced later" — the backfill is the bridge.

The null-when-insufficient-data rule from `packages/schemas/src/effectiveness.ts` must
be preserved: a session with `toolCallCount < 2 AND userMessageCount < 2` legitimately
stores `NULL`, not zero.

## Acceptance criteria

- [ ] Running the backfill job processes all sessions where `friction_score IS NULL OR shape_label IS NULL`, regardless of `last_event_at`.
- [ ] Sessions that legitimately score null (insufficient data per `computeFrictionScore` / `classifySessionShape`) remain null after the backfill; they are not set to 0 or a default label.
- [ ] The job is batched (e.g. cursor/offset loop with a configurable batch size, default 500) so it does not issue a single unbounded UPDATE that locks the table.
- [ ] Re-running the job on an already-backfilled dataset is a no-op (no rows re-updated, job completes successfully).
- [ ] A `job_runs` row is written with status `success` (or `error` on failure), matching the pattern used by the existing nightly job.
- [ ] The existing nightly `compute-effectiveness` job behaviour (48h window) is unchanged; the backfill is a separate callable function or a mode flag.

## Implementation notes

Extract a shared `computeEffectivenessForBatch(sessionIds, db)` helper to avoid
duplicating the histogram-fetch + score-update loop between the nightly job and
the backfill. The backfill can be exposed via `scheduler.ts` as a named job
(`compute-effectiveness-backfill`) so it can be triggered from an admin endpoint or
a one-time `bun run` script. Use the same advisory-lock pattern as the nightly job
to prevent concurrent runs.

Pagination cursor: `WHERE (friction_score IS NULL OR shape_label IS NULL) AND session_id > $cursor ORDER BY session_id LIMIT 500` keeps batches stable across retries.

## Files touched

- `apps/ingest/src/jobs/compute-effectiveness.ts`
- `apps/ingest/src/jobs/scheduler.ts`

## Out of scope

- Changing the nightly job's 48h window.
- Exposing the backfill via a web UI or HTTP endpoint (admin CLI trigger only).
- Re-scoring sessions that already have non-null values (only fill missing).

## Verification

```bash
bun --filter '@app/ingest' test
```

> **Verification status (review):** implementation + `apps/ingest/test/compute-effectiveness.test.ts`
> are written, but the test could **not be executed in the build sandbox**: generating the
> Prisma client requires `binaries.prisma.sh`, which the environment's egress policy denies
> (403), so the ingest module's `import { Prisma }` cannot load. The test must be run in CI
> (which can fetch the engines). Acceptance checkboxes are left unchecked until CI is green.
