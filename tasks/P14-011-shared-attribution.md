---
id: P14-011
title: One cost-attribution implementation, shared by the seed and ingest
phase: 14
workstream: A
status: review
owner: claude
depends_on: [P14-004]
blocks: []
estimate: S
---

## Goal

Seeded data gets `events.attributed_cost_usd` and `events.downstream_cost_usd`
from the **same code path production uses**, so `/org/models`, `/org/tools`,
`/org/skills`, `/org/agents` and their team and `/me` equivalents show real
figures immediately after `bun run db:seed` — without the seed acquiring a
second, private definition of what those numbers mean.

## Context

After a seed both columns were NULL, so every attributed-cost column rendered an
em dash until someone triggered `compute-cost-attribution` by hand. The seed
writes the turn linkage ([`P14-003`](./P14-003-turn-linked-cost-attribution.md))
but not the columns derived from it.

The [`P14-004`](./P14-004-turn-linked-cost-attribution.md) author **correctly
refused** to fix this by duplicating the job's arithmetic in the seed. That is
the defect this whole phase exists to remove, and it has produced three shipped
bugs already:

| Fabrication | Consequence |
|---|---|
| per-tool `cost_usd` on `PostToolUse` rows | MCP and sub-agent cost tiles were fiction (P14-001) |
| a `tool_category` the hook never emitted | a taxonomy that existed only in seeded rows (P14-002) |
| `model` on tool rows | six routing reads and an armed alert dead for a year (P14-005) |

Each passed review because every query was written against the seed and agreed
with it. A seed that recomputes production's arithmetic locally is the same
failure with a different surface: the numbers would look right in every
screenshot and be a second definition of a dollar figure.

But the seed genuinely could not call the job. `packages/db` does not depend on
`apps/ingest` and must not — that inverts the dependency graph — and
`cost-attribution.ts` lived in `apps/ingest/src/lib/`.

## What changed

**The pure arithmetic moved to `packages/schemas/src/cost-attribution.ts`.**
`apps/ingest` keeps the job — the schedule, the settled-session selection, the
hypertable chunk decompression, the `IS DISTINCT FROM` writes. Only the
definitions moved: `computeSessionAttribution`, `inputSideCostUsd`,
`AttributionEvent`, `AttributionRow`, `PriceLookup`, `TURN_END_EVENT_TYPE`,
`TOOL_EVENT_TYPE`.

**`packages/db/src/seed.ts` calls it.** `finalizeTelemetry()` gained a fifth
step: read the seeded turn-linked events back, run them through
`computeSessionAttribution`, write the results with the same
`UPDATE … FROM (VALUES …)` shape and the same in-database numeric casts the job
uses. It runs after the `tool_output_bytes` backfill, which the downstream half
apportions by.

### Why `packages/schemas` and not a new `packages/cost`

Weighed both. `packages/schemas` wins on three counts:

1. **The repo already draws the boundary there, in practice.** The root
   `AGENTS.md` line called it "the zod wire contract for telemetry events", but
   the package has held pure shared *definitions* for several phases:
   `toolCategory()` (P14-002 — shared by the hook adapters and this same seed,
   for this same reason), `computeFrictionScore`, the trajectory scorers,
   `buildScoreRow`, `estimateRoutingSavings`/`blendedRate`, and `judgeCostUsd`.
   Two of those are already cost arithmetic. A new workspace would fragment a
   boundary the codebase has consistently used, and leave a reader asking which
   of the two packages a new shared definition belongs in. That one-line
   description is now updated to say what the package actually is.
2. **`ModelPrice` — the only type the arithmetic depends on — is already there.**
   A `packages/cost` would have to depend on `packages/schemas` for it, so the
   new workspace buys a dependency edge and no isolation.
3. **The bookkeeping is real and buys nothing.** ~205 lines of code and one test
   file would cost a `package.json`, `tsconfig.json`, a `turbo.json` entry,
   catalog pins for `typescript`/`vitest` (PLAN §4), dependency edges in
   `packages/db` and `apps/ingest`, and a `COPY packages/cost/package.json` line
   in each of the four `Dockerfile`s, which name every package explicitly.

A new workspace would be right if the arithmetic grew a dependency `schemas` must
not have (a database driver, a pricing client). It has none: it is a pure
function over numbers.

### Behaviour-preserving

`git mv` for both the module and its test, so history follows. The three suites
P14-004 shipped pass with **no assertion changed**:

- `packages/schemas/src/cost-attribution.test.ts` (was
  `apps/ingest/test/cost-attribution.test.ts`) — 15 tests. Two edits: the import
  paths, and one `reduce` accumulator annotated `(s: number, d)`. That is not a
  loosened assertion — it is the move *tightening* a gate. `packages/schemas`
  typechecks its tests, because they live under `src/`; `apps/ingest/tsconfig.json`
  includes only `src/**/*`, so this file had never been typechecked at all.
- `apps/ingest/test/compute-cost-attribution.test.ts` — untouched, still passes.
- `apps/ingest/test/compute-cost-attribution.db.test.ts` — untouched, DB-gated.

No migration. The two columns have been in `0001_init.sql` since the P14-009
consolidation, and this task adds no column and changes no formula.

## The P14-004 invariants, and where they now bind

Restated because a refactor plus a second writer is exactly where an invariant
gets lost.

- `attributed_cost_usd` and `downstream_cost_usd` are **two lenses on the same
  dollars, never additive.**
- Neither may feed `sessions.total_cost_usd`, `pr_rollups.total_cost_usd`, or any
  continuous aggregate — that chain already counts these dollars once, at `Stop`.
- Where turn linkage is absent the answer is **no attribution**, never `$0.00`.

| Guard | Binds | Status |
|---|---|---|
| the job issues no write naming `total_cost_usd` / `pr_rollups` / a cagg | `apps/ingest/test/compute-cost-attribution.test.ts` | unchanged, still passes |
| nothing in `apps/web` adds the two columns, in either operand order | `apps/web/test/cost-attribution-surfaces.test.ts` | unchanged, still passes |
| the two-turn arithmetic — the same $4 under both names | `packages/schemas/src/cost-attribution.test.ts` | moved with the file |
| **the seed's write names none of that chain, and never rewrites `cost_usd`** | `packages/db/test/seed-cost-attribution.test.ts` | **new** |
| **the seed takes its values from the shared function, never from a SQL expression** | same | **new** |
| **the seed never sums the two columns, in SQL or in TypeScript** | same | **new** |
| **the seed writes NULL, never a coalesced 0** | same | **new** |

The new file is a source-text lint on `src/seed.ts`, the same shape as
`packages/db/test/seed-event-shape.test.ts` — the seed runs `main()` at import,
so it cannot be imported and exercised. Both anti-vacuity assertions are present
(a rule that finds no statements fails), and the two load-bearing rules were
checked by mutation: adding `total_cost_usd = v.attributed + v.downstream` to
the write, and renaming the `computeSessionAttribution` call, each fail the
suite.

## Acceptance criteria

- [x] The arithmetic lives in exactly one place, importable by both
      `packages/db` and `apps/ingest`, with no new dependency edge from
      `packages/db` to an app.
- [x] `apps/ingest` keeps the job: schedule, chunk handling, DB writes.
- [x] The P14-004 tests pass with only import-path changes (plus one type
      annotation the move newly requires — no assertion touched).
- [x] The seed writes both columns via the shared function.
- [x] Every P14-004 guard still binds, and each has a counterpart on the seed's
      write path.
- [x] No new migration; `0001_init.sql` untouched.
- [x] Four gates green: `bun run check`, `typecheck`, `build`, `test`.

## Needs a live database (not verified here)

Deliberately not run — no Docker, no `db:*` script:

1. **`bun run db:seed` populates both columns.** The write path is new; its
   arithmetic is covered by the moved unit tests, and its SQL is the job's,
   which `compute-cost-attribution.db.test.ts` exercises against a real
   database. What is unverified is the two of them composed: the `Prisma.join`
   `VALUES` list against a hypertable with no chunk-range predicate.
2. **The em dash is gone.** `/org/tools`, `/org/skills`, `/org/agents`,
   `/org/models`, `/team/[slug]/*` and `/me/insights` should show figures and a
   coverage note straight after a seed, with no job run. Statically the columns
   are now written and `fmtUsdOrDash` renders non-NULL as a figure, but only a
   seeded database proves the coverage fraction is sane.
3. **Re-seeding an old database.** The seed's attribution write does no chunk
   decompression, matching the byte-volume `UPDATE` immediately above it: a
   fresh seed has no compressed chunks. Re-seeding over a database old enough
   for the 7-day compression policy to have run is untested. It is the
   pre-existing behaviour of the surrounding step, not a regression, but it is
   the one case worth a look.

```bash
bun run docker:infra:up
bun run db:deploy
bun run db:seed
# then: SELECT count(*) FILTER (WHERE attributed_cost_usd IS NOT NULL) FROM events;
DATABASE_URL=<url> bun run --cwd apps/ingest test   # one file at a time
```

## Files touched

- `packages/schemas/src/cost-attribution.ts` (moved from
  `apps/ingest/src/lib/`), `packages/schemas/src/cost-attribution.test.ts`
  (moved from `apps/ingest/test/`), `packages/schemas/src/index.ts`
- `apps/ingest/src/jobs/compute-cost-attribution.ts` (import + header),
  `apps/ingest/src/lib/turn-linkage.ts` (doc reference), `apps/ingest/AGENTS.md`
- `packages/db/src/seed.ts`, `packages/db/test/seed-cost-attribution.test.ts`,
  `packages/db/AGENTS.md`
- `AGENTS.md` (the `packages/schemas` row, and the convention this establishes)

## Out of scope

- **Changing any formula, surface, or the job's schedule.** This is a move plus
  a second caller.
- **Giving the seed a per-model price table.** It prices every model at the one
  rate `calcCost` uses, because the downstream half redistributes the `cost_usd`
  `calcCost` produced — a different table would leave the two halves of a seeded
  session disagreeing. Seeding realistic per-model rates is its own question,
  and it is `calcCost`'s to answer first.
- **Chunk decompression in the seed.** See "Needs a live database" (3).
- **The model-routing redistribution** ([`P14-005`](./P14-005-model-routing-attribution.md)).
