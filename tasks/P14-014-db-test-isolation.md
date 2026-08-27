---
id: P14-014
title: Let the DB-gated suites share a database
phase: 14
workstream: A
status: done
owner: claude
depends_on: [P14-009]
blocks: []
estimate: S
---

## Goal

`packages/db/test/schema.test.ts`, `apps/ingest/test/reprice-events.db.test.ts`
and `apps/ingest/test/compute-cost-attribution.db.test.ts` can run against one
shared Postgres/Timescale database — repeatedly, in any invocation — without
interfering with each other, and CI actually executes them.

## Context

P14-009 found that the two `apps/ingest` suites fail when run together against
one database (`packages/db/AGENTS.md`, the "Finding" note it added), documented
the mechanism, and left it unfixed as out of scope for a migration-consolidation
task. All three suites are `describe.skipIf(!DATABASE_URL)`, and `bun run test`
sets no `DATABASE_URL`, so they had never executed anywhere except one manual
run during P14-009.

## Reproduction — confirmed, diagnosis matches P14-009's finding

Brought up `docker-compose.infra.yml` (Postgres 18 + TimescaleDB, fresh
`./data`), ran `bun run db:deploy`, then ran the two ingest suites together
repeatedly with plain `vitest run` (default parallelism, no fix applied). Both
failure modes reproduced, plus a third variant of the same root cause:

**1 — deadlock**, `reprice-events-apply` job failing inside the suite:
```
{"err":{"code":"P2010", ... "cause":{"originalCode":"40P01",
"originalMessage":"deadlock detected", ...
"detail":"Process 182 waits for AccessExclusiveLock on relation 19918 of
database 16384; blocked by process 184.\nProcess 184 waits for
RowExclusiveLock on relation 19918 of database 16384; blocked by process
182."}}}
```
and, in a different run, the same deadlock surfacing directly from
`compute-cost-attribution.db.test.ts`'s own `beforeAll` (`compress_chunk` /
`show_chunks`):
```
PrismaClientKnownRequestError: Raw query failed. Code: `40P01`.
Message: `deadlock detected`
 ❯ test/compute-cost-attribution.db.test.ts:140:5
```

**2 — the chunk-count assertion seeing the other suite's compression**, though
in this run it showed up as `42710 chunk "..." is already compressed` (one
suite's `compress_chunk` racing the other's, rather than the exact `expected 1
to be 2` from P14-009 — same root cause, different manifestation of two
concurrent, unscoped chunk operations):
```
"originalCode":"42710","originalMessage":"chunk \"_hyper_1_1_chunk\" is
already compressed"
```
and directly:
```
expected 2 to be 1 // Object.is equality
 ❯ test/compute-cost-attribution.db.test.ts:220:48
```

8 consecutive plain-parallel runs produced failures in 6 of them — confirming
this is the nondeterministic race P14-009 described, not a deterministic bug.

**Root cause, confirmed by reading the job source (not just observed):**
`repriceEventRows` (`apps/ingest/src/jobs/reprice-events.ts`) calls
`listEventChunks(db)` with **no `since` bound** — every chunk of the whole
`events` hypertable, unscoped to the suite's own fixture rows. The test's own
`runComputeCostAttribution` call passes `lookbackDays: 3650`, which resolves to
the same effective scope — every chunk. Both suites' job runs therefore call
`decompress_chunk` / `compress_chunk` (`AccessExclusiveLock`) over the **same**
physical chunks when run concurrently, and `reprice-events`'s own `UPDATE
events` (`RowExclusiveLock`) can be caught mid-flight by the other suite's
decompress. This is inherent to how both jobs are designed to operate on the
whole table (that is their production job, not a test artifact) — it is not
something a test-side assertion fix can address, confirming P14-009's
diagnosis: **the deadlock and the miscounted chunks are the same underlying
concurrency problem, not two independent bugs.**

## Fix chosen: serialize the two conflicting files against each other, scoped narrowly

`apps/ingest/vitest.config.ts` (new) splits the suite into two vitest
`projects`:

- `unit` — every non-DB test file (`test/*.test.ts` except `*.db.test.ts`),
  running at full default parallelism, unchanged from before.
- `db` — only `test/*.db.test.ts`, with `fileParallelism: false`, so its files
  always run one at a time within that project regardless of how many workers
  the rest of the suite uses.

This makes **`bun run test` itself** immune to the race — no separate script to
remember, and no way to silently reintroduce it by exporting `DATABASE_URL` and
running the normal command. `apps/ingest/package.json` also gained a
`test:db` script (`vitest run --no-file-parallelism test/*.db.test.ts`) as a
narrow, explicit entry point for CI (see below) and local runs that want only
the DB-gated suites.

`packages/db/test/schema.test.ts` needed no serialization against the other two
— it never touches `events` or its chunks — so it runs safely in parallel with
either, and does in the repeated-run evidence below (`packages/db`'s own `test`
alongside `apps/ingest`'s `test:db`, as two concurrent processes against one
database).

### Alternatives considered and rejected

- **`fileParallelism: false` for the whole `apps/ingest` workspace.** Simplest
  one-line change, but serializes all ~30 non-DB files too, on every run where
  `DATABASE_URL` happens to be set (including the new CI job below, every time
  it runs). The `projects` split gets the same guarantee for the two files that
  actually need it without that cost.
- **A database per suite.** Real isolation — no shared chunks, no shared
  advisory locks, immune to future jobs that widen their own scope. Rejected
  for the size of the machinery it needs: provisioning and tearing down two
  extra databases (or Postgres instances) per test run, applying both migration
  layers to each before every run, and teaching each suite how to find its own
  `DATABASE_URL` instead of reading one from the environment. `packages/db`'s
  own migration tooling is designed around one long-lived database
  (`packages/db/AGENTS.md`'s reset procedure, the `_db_sql_migrations`
  tracking table) — bending it to ephemeral per-suite databases is a
  meaningfully bigger surface than this task's scope, for a problem the
  `projects` split already solves.
- **Scope the compressed-chunk assertion to the suite's own chunk.** Smallest
  diff, and it would have fixed failure (2) — but confirmed by reading
  `reprice-events.ts` and `compute-cost-attribution.ts`: **the deadlock in (1)
  is not a test-assertion problem.** Both jobs' own SQL (`listEventChunks` with
  no bound, `lookbackDays: 3650`) touches every chunk in the hypertable, by
  design — that is the job's real production behavior, not something the test
  can narrow without changing what it exercises. A fix that only rescoped the
  assertion would have left the deadlock fully reproducible; not implemented,
  per the task's own instruction not to ship a fix that makes the symptom go
  away without addressing the lock collision.

## A third bug found while fixing this: `schema.test.ts`'s unscoped cleanup

`packages/db/test/schema.test.ts`'s `afterAll` called `deleteMany()` with **no
`where` clause** on `session`, `user`, `team`, `repo`, `pRRollup`,
`sessionPRLink`, `pullRequest`, `auditLog`, `visibilityPolicy` and `authToken` —
deleting every row of each table, not just the ones the suite created.
`events.session_id` has `FOREIGN KEY ... ON DELETE CASCADE`
(`packages/db/sql/migrations/0001_init.sql`), so an unscoped `session.deleteMany()`
would cascade-delete **every row of `events`**, including the other two suites'
fixture data, the moment `schema.test.ts` shared a database with them — in any
order, not just literal concurrent execution. This is exactly the kind of bug
"make the suites able to share a database" exists to catch, so it is fixed here
even though it isn't one of the two originally-described failures: every delete
in the `afterAll` is now scoped to the ids (`teamId`, `userId`, `repoId`,
`sessionId`) the suite itself created, matching the pattern the other two
DB-gated suites already use.

## Making them run somewhere

Added a `db-tests` job to `.github/workflows/ci.yml`: a `timescale/timescaledb`
service container, `bun run db:deploy` against it, then
`bun run --cwd packages/db test && bun run --cwd apps/ingest test:db`. The
existing `ci` job is untouched and still sets no `DATABASE_URL`, so the two jobs
partition the suite rather than duplicating work: `ci` runs everything except
the three DB-gated files (they skip there, as before), `db-tests` runs only
those three, against a real database, on every push and PR.

Local equivalent: `bun run docker:infra:up && bun run db:deploy`, then
`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_agents_observability
bun run test` (root) or `bun run --cwd apps/ingest test:db` /
`bun run --cwd packages/db test` individually.

**Caveat for later:** `turbo.json` currently lists `DATABASE_URL` under
`globalPassThroughEnv`, which makes it visible to tasks at runtime but
deliberately excluded from Turbo's cache-key hashing. That's fine today — CI has
no persisted Turbo cache between jobs — but if remote caching is ever added,
`DATABASE_URL` would need to move to a task-level `env` declaration for `test`,
or a cached "skipped, no `DATABASE_URL`" result could be replayed for a run that
should have executed the DB-gated suites for real. Not fixed here: no remote
cache exists to make it observable yet.

## Verification

**Reproduced first** (see above), against real Postgres 18 / TimescaleDB, on the
pre-fix tree — both failure modes observed with default vitest parallelism,
across 8 runs.

**Each suite still passes alone:**
- `apps/ingest`: `reprice-events.db.test.ts` — 6 passed.
- `apps/ingest`: `compute-cost-attribution.db.test.ts` — 6 passed.
- `packages/db`: `schema.test.ts` (part of the package's 6-file, 31-test run) —
  passed.

**The two ingest suites together, repeatedly:**
- `vitest run test/compute-cost-attribution.db.test.ts test/reprice-events.db.test.ts
  --no-file-parallelism` (what `bun run test:db` runs): 8/8 clean runs, 12/12
  tests passing every time.
- Plain `bun run test` (no explicit flag — proving the `vitest.config.ts`
  `projects` split protects the default command, not just `test:db`) **with
  `DATABASE_URL` set**: 8/8 clean runs, all 281 tests passing (269 non-DB + 12
  DB), ~1.6–1.9s wall clock each — the ~30 non-DB files still ran at full
  parallelism.

**All three suites together, as two concurrent processes against one
database** (`packages/db`'s `bun run test` launched alongside `apps/ingest`'s
`bun run test:db`, `wait`ed on both): 8/8 consecutive runs, `packages/db`
6 files / 31 tests passed and `apps/ingest` 2 files / 12 tests passed, every
time.

**The new CI job's steps, run locally against the same database:**
`DATABASE_URL=...` (env var only, no `.env` file — confirmed Bun's
`--env-file=../../.env` in `db:deploy`/`test` scripts silently no-ops on a
missing file and falls through to the already-exported var) →
`bun run db:deploy` → `bun run --cwd packages/db test` →
`bun run --cwd apps/ingest test:db`. All green.

**Four gates**, in order: `bun run check` → `bun run typecheck` → `bun run build`
→ `bun run test` (default, no `DATABASE_URL` — confirms the DB-gated suites
still skip cleanly and nothing else regressed).

## Files touched

- `apps/ingest/vitest.config.ts` — **new**. `projects` split: `unit` (default
  parallelism, excludes `*.db.test.ts`) and `db` (`fileParallelism: false`,
  only `*.db.test.ts`).
- `apps/ingest/package.json` — new `test:db` script.
- `apps/ingest/test/reprice-events.db.test.ts` — header comment cross-references
  the isolation fix.
- `apps/ingest/test/compute-cost-attribution.db.test.ts` — header comment
  updated from "run one at a time" (manual caveat) to how the fix makes that
  automatic.
- `packages/db/test/schema.test.ts` — `afterAll` cleanup scoped to the suite's
  own rows (the third bug above).
- `packages/db/AGENTS.md` — the P14-009 "Finding" note updated to record the
  fix, the `schema.test.ts` bug, and the new CI job.
- `.github/workflows/ci.yml` — new `db-tests` job.
- `tasks/P14-014-db-test-isolation.md` — this file.

## Out of scope

- **A database-per-suite.** Rejected above; the `projects` split solves the
  concurrency problem this task set out to fix without it.
- **Narrowing `listEventChunks` / the reprice and cost-attribution jobs to a
  time-bounded or session-scoped query.** That's `apps/ingest/src/**`, owned by
  a sibling task/agent, and changing it would change production job behavior —
  out of scope for a test-infrastructure task regardless.
- **Turbo's `DATABASE_URL` cache-key caveat**, noted above but not fixed — no
  remote cache exists yet to make the staleness observable.
