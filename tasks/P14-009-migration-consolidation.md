---
id: P14-009
title: Consolidate the custom SQL migration layer back to one file
phase: 14
workstream: A
status: done
owner: claude
depends_on: [P14-002, P14-004, P14-006]
blocks: []
estimate: S
---

## Goal

`packages/db/sql/migrations/` is back to **one file**, `0001_init.sql`, and the
schema it produces on an empty database is provably the same schema the
four-file chain produced.

## Context

The custom SQL layer is documented in [`packages/db/AGENTS.md`](../packages/db/AGENTS.md)
as "one Prisma migration; a forward-only chain of SQL files", and it has been
squashed back to one file three times before — 2026-08-14 (from nine files),
2026-08-18 (P13-012 / P13-013) and 2026-08-21 (the P10-005 alert seed). Phase 14
added three more files, so the layer had drifted to four:

| File | Added by | Contents |
|---|---|---|
| `0001_init.sql` | — | the whole Timescale layer |
| `0002_tool_category_backfill.sql` | P14-002 | one `UPDATE events SET tool_category = CASE …` |
| `0003_tool_cost_attribution.sql` | P14-004 | `attributed_cost_usd`, `downstream_cost_usd`, + a view replace |
| `0004_live_turn_linkage.sql` | P14-006 | `tool_use_id`, a partial index, + a view replace |

The owner authorised the squash on the documented grounds that nothing is
deployed anywhere. **The Prisma layer was out of scope** — it is already a single
migration, `schema.prisma` and `prisma/migrations/20260814000000_init/` last
changed in the same commit, and Phase 14 touched neither, because `events` is a
hypertable Prisma cannot model.

## What was done

**`0002_tool_category_backfill.sql` — deleted, not folded.** It is a pure data
backfill over rows ingested before P14-002, when producers wrote a flat
`builtin` / `mcp` instead of the real taxonomy. On a database created fresh from
a consolidated `0001` there are zero such rows, and every producer now calls
`toolCategory()` at capture time. Folding a data backfill into a schema file
leaves dead SQL that runs on every fresh database forever.

**`0003` and `0004` — folded.** Their three `ALTER TABLE events ADD COLUMN`s are
now columns of `0001`'s `CREATE TABLE events`, placed in their logical groups
(`tool_use_id` with the other `tool_*` columns, the two attribution columns after
`cost_usd`). All three `COMMENT ON COLUMN` statements came across **verbatim** —
they carry the non-additive invariant, which is the whole reason P14-004 wrote
them. The partial `events_session_tool_use_id_idx` moved in with `0001`'s other
index definitions, keeping the prose explaining why it is partial and why the two
attribution columns deliberately get no index.

**Both files' `CREATE OR REPLACE VIEW interactive_events` was dropped.** That
statement existed only because the columns arrived *after* the view: Postgres
expands `SELECT *` at view-creation time and freezes the resolved column list
into the rewrite rule. With the columns in the original `CREATE TABLE`, `0001`'s
own `CREATE VIEW … SELECT * FROM events` picks them up. The **rule** the two
statements embodied did not go away — it moved to `packages/db/AGENTS.md` and to
a comment beside the view in `0001_init.sql`: a *new* numbered migration that
adds an `events` column must still replace that view in the same file.

## Verification

Run against a real Postgres 18 / TimescaleDB, not by reading. Two empty
databases, the pre-squash chain applied to one and the consolidated file to the
other.

**1 — both layers stand alone on an empty database.** `bun run db:deploy` applied
`prisma migrate deploy` (1 migration) then `applySqlMigrations()` (1 file) with
no errors.

**2 — `pg_dump --schema-only` diff: 2465 lines, 26 changed lines, all accounted
for.**

- 2 lines: pg_dump's own per-run `\restrict` / `\unrestrict` nonce. Not schema.
- 24 lines: **physical column order only.** The three folded columns moved from
  appended-after-`metadata` into their logical groups; `interactive_events`
  mirrors that order; the three `COMMENT ON COLUMN` statements are emitted in the
  new attnum order with byte-identical text. This is exactly what folding an
  `ALTER TABLE ADD COLUMN` into a `CREATE TABLE` does, and the 2026-08-18 squash
  recorded the same single difference for `scores`.

Nothing else differed — no index, constraint, default, nullability, type, view
definition or continuous aggregate. **Nothing depends on physical position:**
every writer names its columns explicitly (`apps/ingest/src/lib/insert-events.ts`,
`packages/db/src/seed.ts`, and the DB-gated tests all use
`INSERT INTO events (col, …) VALUES …`), and every reader goes through Prisma or
a named `SELECT`.

**2b — TimescaleDB state compared separately,** because `pg_dump` does not carry
it. `timescaledb_information.hypertables`, `.compression_settings`, `.jobs` and
`.continuous_aggregates` (including each aggregate's stored `view_definition`)
are **identical** across the two databases: same `segmentby = user_id,
session_id` / `orderby = ts DESC`, same 7-day compression policy, same three
refresh policies.

**3 — the views really carry the new columns,** checked through
`information_schema.columns` rather than by reading the SQL, because the failure
mode is silent and ships columns nothing can read:

```
 table_name         | column_name         | ordinal_position
--------------------+---------------------+------------------
 interactive_events | tool_use_id         |               18
 interactive_events | attributed_cost_usd |               31
 interactive_events | downstream_cost_usd |               32
```

`interactive_events` has **38** columns; `events` has **38**.

**4 — the Prisma layer still regenerates identically.**
`prisma migrate diff --from-migrations ./prisma/migrations --to-schema
./prisma/schema.prisma` against a shadow database reports an **empty** diff
(`--exit-code` → 0). Regenerating from scratch with `--from-empty --to-schema`
produces **118 statements matching the committed `20260814000000_init` exactly** —
same count, byte-identical once normalized for statement order. That is the same
figure the 2026-08-21 squash recorded, now with no residual `ASC` noise because
the check no longer routes through introspection.

*(`prisma db push` was not used: Prisma 7's CLI refuses it under an AI-agent
safety guard that requires the human user's own consent text. `migrate diff
--from-migrations` answers the same question non-destructively and more directly.)*

**5 — the three DB-gated suites, which had never executed anywhere, all pass.**

| Suite | Result |
|---|---|
| `packages/db/test/schema.test.ts` | 11 passed |
| `apps/ingest/test/reprice-events.db.test.ts` | 6 passed |
| `apps/ingest/test/compute-cost-attribution.db.test.ts` | 6 passed |

**6 — `bun run db:seed` completes cleanly** against the consolidated schema, and
the three folded columns are selectable through `interactive_events`.

**7 — `test/agent-type-parity.test.ts` and `test/scores-period-key.test.ts`,**
which read `0001_init.sql` as TEXT on purpose, still pass; all four gates are
green.

## Finding — the DB-gated suites must be run one file at a time

Running `reprice-events.db.test.ts` and `compute-cost-attribution.db.test.ts` in
the **same** vitest invocation against one database fails. Two different ways, on
different runs:

- `deadlock detected` — `AccessExclusiveLock` vs `RowExclusiveLock` on the same
  relation, when one suite recompresses a chunk while the other writes to it;
- `expected 1 to be 2` at `reprice-events.db.test.ts:164`, which counts *all*
  compressed chunks of `events` (`WHERE hypertable_name = 'events' AND
  is_compressed`) and so sees the other suite's compression.

Each file passes on its own. This is **pre-existing and unrelated to the squash**:
it reproduces identically against the pre-squash schema. It has never been
noticed because `bun run test` sets no `DATABASE_URL`, so all three suites skip —
which is also why CI is unaffected.

Left unfixed here: the fix is a cross-cutting decision (`fileParallelism: false`
for `apps/ingest`, a per-suite database, or scoping the chunk-count assertion to
the suite's own chunk), and this task is a migration consolidation. Documented
instead, in `packages/db/AGENTS.md` and in the header of
`compute-cost-attribution.db.test.ts`.

## ⚠️ Every existing local database must be reset

`applySqlMigrations()` tracks applied filenames in `_db_sql_migrations` and skips
anything already recorded. An existing database has `0001_init.sql` recorded, so
**the rewritten file will not re-run** — and there is no error to tell you. Do
not delete rows from `_db_sql_migrations` to force it; that re-runs the whole
init file against a populated database.

```bash
bun run docker:infra:down:v   # DESTRUCTIVE — wipes ./data (Postgres + MinIO + Grafana)
bun run docker:infra:up
bun run db:deploy
bun run db:seed               # optional
```

## Files touched

- `packages/db/sql/migrations/0001_init.sql` — three columns, three column
  comments, one partial index folded in; header records the squash
- `packages/db/sql/migrations/0002_tool_category_backfill.sql` — **deleted**
- `packages/db/sql/migrations/0003_tool_cost_attribution.sql` — **deleted** (folded)
- `packages/db/sql/migrations/0004_live_turn_linkage.sql` — **deleted** (folded)
- `packages/db/AGENTS.md` — current-files list, the running squash log with this
  squash's evidence, the `SELECT *` standing rule promoted out of the deleted
  files' bullets, and the reset warning
- `apps/ingest/test/compute-cost-attribution.db.test.ts` — header referred to
  `0003_tool_cost_attribution.sql` by name; corrected, and the run-one-at-a-time
  caveat added
- `DESIGN_DOC.md` — decision-log entry
- `tasks/P14-009-migration-consolidation.md` — this file

## Out of scope

- **The Prisma layer.** Not regenerated, not renumbered — only verified.
- The historical task files (`P14-002`, `P14-004`, `P14-006`) still name the
  deleted migrations. They are records of what those tasks did at the time and
  are deliberately left alone; the current state is in `packages/db/AGENTS.md`.
- Fixing the DB-gated suites' mutual interference (see the finding above).
