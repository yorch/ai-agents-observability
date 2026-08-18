---
id: P13-001
title: Generic versioned scores table
phase: 13
workstream: A
status: review
owner: claude
depends_on: []
blocks: [P13-003, P13-004, P13-005, P13-006, P13-007, P13-008, P13-009]
estimate: M
---

## Goal

Introduce one `scores` table that any scorer — heuristic, deterministic, human, or
judge — writes into, carrying scorer identity, version, and provenance. Migrate
`friction_score` and `shape_label` to write rows through it, keeping the existing
`sessions` columns as a denormalized "current value" cache so no dashboard changes.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§2.3 (R1). Today every computed signal is a hard-wired column on `sessions`
(`friction_score`, `shape_label`, `total_response_ms`, `response_sample_count`) with:

- **no scorer identity** — you cannot tell which scorer produced a value,
- **no version** — `FRICTION_VERSION = 1` lives in
  `packages/schemas/src/effectiveness.ts` with nowhere to be recorded per score,
  which is why `DESIGN_DOC.md` §12.7 had to describe the effectiveness widgets as
  "version-pinned" by convention,
- **no room for disagreement** — a second scorer over the same session has no place
  to put its answer, which makes calibration (P13-005) impossible,
- **no re-scoring path** — `compute-effectiveness` treats `shape_label IS NULL` as
  its "already scored" marker for idempotency, so improving a scorer cannot re-score
  history without another one-shot backfill job.

Every other Phase 13 task reduces to "write rows into this table," so the schema
shape matters more than the migration mechanics.

## Acceptance criteria

- [x] A `scores` table exists with at least: `id`, `subject_type`, `subject_id`,
      `scorer_name`, `scorer_version`, `source`, `value` (nullable numeric),
      `label` (nullable text), `metadata` (JSONB), `rationale_ref` (nullable),
      `cost_usd` (nullable), `created_at`.
- [x] `source` is constrained to `heuristic | deterministic | human | judge | outcome`.
- [x] `subject_type` is constrained to at least `session`; `pull_request`, `skill`,
      and `mcp_server` are accepted values so P13-004 needs no migration.
- [x] A uniqueness constraint prevents duplicate rows for the same
      `(subject_type, subject_id, scorer_name, scorer_version)` — re-running a scorer
      at the same version is idempotent; bumping the version writes a new row rather
      than overwriting history.
- [x] `compute-effectiveness` writes a `scores` row for friction (`source:
      heuristic`, `scorer_version` from `FRICTION_VERSION`) and one for shape, in the
      same transaction as the existing column update.
- [x] The existing `sessions.friction_score` / `shape_label` columns still carry the
      current value, and no existing dashboard, query, or facet changes behaviour.
      Existing effectiveness tests pass unmodified.
- [x] Re-scoring is possible without a bespoke job: a documented path exists to
      recompute a scorer at a new version over historical sessions, driven by the
      absence of a row at that `(scorer_name, scorer_version)` rather than by
      `shape_label IS NULL`.
- [x] Deletion and retention cover scores: a `DeletionRequest` for a user removes
      their score rows, and score rows for a session do not outlive the session.
- [x] A pure, unit-tested helper writes and reads scores; scorer names are a typed
      union in `packages/schemas`, not free strings at call sites.

## Implementation notes

- Prisma model + a numbered SQL migration under `packages/db/sql/migrations/`
  (next free ordinal after `0006_seed_routing_waste_alert.sql`). **Read
  [`packages/db/AGENTS.md`](../packages/db/AGENTS.md) first** — the squashed init
  migration drifts silently if patched.
- Index for the two dominant reads: `(subject_type, subject_id)` for "all scores for
  this session," and `(scorer_name, scorer_version, created_at DESC)` for
  calibration and drift queries.
- `rationale_ref` is a *pointer* (e.g. an S3 key), not inline text. Judge rationales
  are derived from redacted transcripts and inherit their sensitivity — they must not
  become a JSONB free-for-all outside the retention and deletion paths.
- Keep `value` and `label` separate rather than overloading one column: numeric
  scorers (friction) and categorical scorers (shape) both exist, and calibration
  needs to treat them differently.
- Design field names *toward* the emerging OTel GenAI evaluation event so a future
  bridge is a mapping and not a migration — but do not adopt the wire format
  (Development status, no stabilization timeline).
- Backfilling historical sessions into `scores` is optional for this task; the
  columns remain authoritative for display until P13-005/P13-006 need the history.

## Files touched

- `packages/db/prisma/schema.prisma` (`Score`) — Prisma models it fully, so it is a
  relational migration and no `sql/migrations/` file was needed
- `packages/schemas/src/scores.ts` (+ test) — scorer-name union, source enum, row type
- `packages/schemas/src/index.ts`
- `apps/ingest/src/jobs/compute-effectiveness.ts`
- `apps/ingest/src/jobs/run-deletions.ts`

## Out of scope

- Any new scorer. This task moves existing signals onto the substrate; P13-003 and
  P13-004 add scorers.
- Changing the friction weights or the shape classifier. Behaviour-preserving only —
  a scorer change and a schema change in one commit is unreviewable.
- A UI for scores. P13-006 builds the first read surface.
- Backfilling every historical session into `scores`.

## Verification

```bash
bun install
bun run --cwd packages/db typecheck
bun --filter '@ai-agents-observability/schemas' test scores
bun --filter '@ai-agents-observability/ingest' test compute-effectiveness
bun run check
bun run typecheck
bun run build
bun run test
```
