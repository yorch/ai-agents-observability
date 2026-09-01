# packages/db — agent notes

> `CLAUDE.md` here is a symlink to this file. Edit `AGENTS.md`.
>
> **Root rules still apply.** Claude Code concatenates this file with the repo-root
> [`AGENTS.md`](../../AGENTS.md); some other agents load only the *nearest* file.
> The invariants most expensive to lose are restated here for that case:
> four gates before every commit (`bun run check` → `typecheck` → `build` → `test`),
> and `packages/schemas` is the only source of telemetry event shapes.

Prisma 7 + **TimescaleDB**. Schema at `prisma/schema.prisma`; client generated to
`src/generated/client` (gitignored — `postinstall` runs `db:generate`).

## Two migration layers, one runner

Migrations are applied by the one-shot `infra/migrations-runner/` container, **not**
by app entrypoints. It waits for Postgres health, runs both layers, exits 0; the other
services gate on `condition: service_completed_successfully` in compose. With four
services needing the same schema state, migrate-on-boot in each would race.

`src/deploy.ts` (`bun run db:deploy`) is the same path for local use.

| Layer | Lives in | Applied by | Holds |
|---|---|---|---|
| 1. Relational | `prisma/migrations/20260814000000_init/` | `prisma migrate deploy` | Everything Prisma models |
| 2. Custom SQL | `sql/migrations/NNNN_*.sql` | `applySqlMigrations()` (`src/sql-migrate.ts`) | Everything it can't |

Layer 2 runs **after** layer 1, in filename order. Each file runs **once**:
`applySqlMigrations()` tracks applied filenames in `_db_sql_migrations` and skips
any file already recorded there, so a file does not re-run on later boots.
Files still use `IF NOT EXISTS` / `CREATE OR REPLACE` as belt-and-braces for a
half-applied file (a crash mid-transaction), not because the file is expected to
run twice — don't rely on "it'll just re-apply" reasoning when writing one, and
never clear `_db_sql_migrations` to force a re-run.

## The drift trap — read this before touching `schema.prisma`

The relational layer is a **single squashed init migration** (the project is
pre-deployment; phase migrations were merged). Prisma's idempotency check is
**name-based**: editing `migration.sql` after it has been applied to a database is
silently ignored, and your local DB drifts from the schema with no error.

So whenever `schema.prisma` changes, **reset — don't patch**:

```bash
bun run docker:infra:down:v   # DESTRUCTIVE — wipes ./data volumes
bun run docker:infra:up
bun run db:deploy
bun run db:seed               # optional
```

## What belongs in `sql/migrations/`, and what doesn't

The rule is **not** "no `ALTER TABLE`" — it is **"nothing Prisma could have modelled."**

`events` is a TimescaleDB hypertable and does not appear in `schema.prisma` at all, so
`ALTER TABLE events ADD COLUMN IF NOT EXISTS …` is correct here, and `0001_init.sql`
creates the whole table this way. What's forbidden is patching a **Prisma-managed**
table from this layer to dodge the reset above — that produces a schema Prisma can no
longer regenerate.

**One Prisma migration; a forward-only chain of SQL files.** The relational layer
is a single squashed Prisma-generated migration, and a change to `schema.prisma`
is regenerated into it, never hand-patched. Anything Prisma cannot model goes in
the custom layer — not folded into the Prisma migration, where the next
regeneration would drop it. The custom layer started as one file and **grows by
appending a new numbered file**; `0001_init.sql` is closed.

Current files — **three**:

- `0001_init.sql` — everything Prisma cannot model, in one file: the `events`
  hypertable (all columns, including `run_kind`, `notification_kind`,
  `tool_target_hash`, `tool_action`, the two P14-004 attribution columns
  `attributed_cost_usd` / `downstream_cost_usd`, and P14-006's `tool_use_id`)
  with its indexes — among them the partial `events_session_tool_use_id_idx` the
  turn-linkage job reads — its compression and retention policies; the three
  continuous aggregates, each defined **once** and already filtered to
  `run_kind = 'INTERACTIVE'`; the `transcript_index` FTS table with its
  generated `tsvector`; two things Prisma cannot express on a Prisma-managed table
  (the partial `sessions_run_kind_idx`, and `NOT NULL` on the `redaction_flags`
  scalar list); the built-in alert-rule seeds; the `scores` unique index, which
  needs `NULLS NOT DISTINCT` (P13-013) and so has no `@@unique` in
  `schema.prisma` at all; and the `interactive_sessions` / `interactive_events`
  views that carry the `run_kind` guard (P13-012).
- `0002_secret_exposure_rule.sql` — seeds the `secret_exposure` alert rule
  (Phase 16 S1), disabled by default. A forward-only numbered file rather than a
  fold into `0001_init.sql`, because `0001` is closed.
- `0003_team_spend_spike_rule.sql` — seeds the `team_spend_spike` alert rule
  (Phase 16 C2), disabled by default. Same rationale as `0002`.

**The `SELECT *` rule survives the squash, and still binds.** `interactive_events`
is `SELECT * FROM events WHERE run_kind = 'INTERACTIVE'`, and Postgres expands the
star **at view-creation time**, freezing the column list into the rewrite rule. In
`0001_init.sql` every column exists before the view is created, so a fresh
database is fine. But **a new numbered migration that adds an `events` column must
carry its own `CREATE OR REPLACE VIEW interactive_events …` in the same file**, or
the column is invisible to every human-facing read in `apps/web`, which names the
view rather than the base table. That rule is not advice: it is why the folded
`0003_tool_cost_attribution.sql` and `0004_live_turn_linkage.sql` each carried
one, and why folding them let both of those statements go away.

**Squashed four times, all pre-deployment.** 2026-08-26 (P14-009) folded
`0003_tool_cost_attribution.sql` (P14-004) and `0004_live_turn_linkage.sql`
(P14-006) back into `0001_init.sql` — three `ALTER TABLE events ADD COLUMN`s
became columns of the `CREATE TABLE`, their `COMMENT ON COLUMN`s and the partial
`events_session_tool_use_id_idx` came with them, and both files'
`CREATE OR REPLACE VIEW interactive_events` was **dropped**: that statement
existed only because the columns arrived after the view, and `0001`'s own
`CREATE VIEW` now creates with them in place.
`0002_tool_category_backfill.sql` was **deleted rather than folded** — it was a
pure `UPDATE events SET tool_category = CASE …` over rows ingested before
P14-002, every producer now stamps the real category at write time, and a
database created from `0001` has no such rows; folding a data backfill into a
schema file leaves dead SQL that runs on every fresh database forever. (Checked
against the seed rather than assumed: after `db:seed`, every `PostToolUse` row
with a `tool_name` already carries a real taxonomy value — `exec`, `fs_write`,
`search`, `mcp`, … — and the only NULL `tool_category` rows have no `tool_name`,
so they fall outside the deleted file's `WHERE` clause anyway.)
Verified against a real database, not by reading:
  - **Both layers applied to a completely empty database from scratch**, and again
    on a second empty database for the pre-squash chain, so the two could be
    compared.
  - **`pg_dump --schema-only` diff, pre-squash vs post-squash: 2465 lines, 26
    changed lines, and every one of them accounted for.** Two are pg_dump's own
    per-run `\restrict`/`\unrestrict` nonce. The rest are *position only*: the
    three folded columns now sit in their logical groups inside `events`
    (`tool_use_id` with the other `tool_*` columns, the two attribution columns
    after `cost_usd`) instead of appended after `metadata`, `interactive_events`
    mirrors that order, and the three `COMMENT ON COLUMN` statements are emitted
    in the new attnum order with byte-identical text. That is exactly what
    folding an `ALTER TABLE ADD COLUMN` into a `CREATE TABLE` does. **No index,
    constraint, default, nullability, type, view definition or continuous
    aggregate differed.** Nothing depends on physical position: every writer
    (`apps/ingest/src/lib/insert-events.ts`, `src/seed.ts`, the DB-gated tests)
    names its columns explicitly, and every reader goes through Prisma or a named
    `SELECT`.
  - **TimescaleDB state compared separately**, because `pg_dump` does not carry
    it: `timescaledb_information.hypertables`, `.compression_settings`, `.jobs`
    and `.continuous_aggregates` (including each cagg's stored `view_definition`)
    are **identical** across the two databases — same segmentby/orderby, same
    7-day compression policy, same three refresh policies.
  - **The views were checked through `information_schema.columns`, not by reading
    the SQL** — the failure mode here ships columns nothing can read.
    `interactive_events` has 38 columns, exactly as many as `events`, and carries
    `attributed_cost_usd`, `downstream_cost_usd` and `tool_use_id`.
  - **Prisma layer untouched and still regenerating identically**: `prisma migrate
    diff --from-migrations ./prisma/migrations --to-schema ./prisma/schema.prisma`
    against a shadow database reports an **empty** diff, and regenerating from
    scratch (`--from-empty --to-schema`) produces **118 statements, matching the
    committed `20260814000000_init` exactly** — same count, and byte-identical
    once normalized for statement order.
  - **The three DB-gated suites that had never run anywhere all pass**:
    `packages/db/test/schema.test.ts` (11), plus
    `apps/ingest/test/reprice-events.db.test.ts` (6) and
    `compute-cost-attribution.db.test.ts` (6). At the time, they had to be run
    one file at a time — given one database they interfered, because both
    ingest suites decompress and recompress chunks of the same `events`
    hypertable and refresh the same continuous aggregates, so in parallel they
    either deadlocked or read each other's compressed-chunk counts. That was
    pre-existing and unrelated to the squash: it reproduced identically
    against the pre-squash schema, and `bun run test` never hit it because
    these suites skip with no `DATABASE_URL`.
    **[P14-014](../../tasks/P14-014-db-test-isolation.md) fixed this.**
    `apps/ingest/vitest.config.ts` puts the two `*.db.test.ts` files in their
    own vitest project with `fileParallelism: false`, so they always run
    serialized against each other — under `bun run test`, `bun run test:db`,
    or any other invocation — while the ~30 non-DB ingest files keep running
    at full parallelism. `schema.test.ts` was also found to run an *unscoped*
    `deleteMany()` in its cleanup (no `where` clause on `sessions`/`users`/…),
    which would have cascade-deleted a sibling suite's `events` fixture rows
    (`events.session_id` cascades on session delete) had the three ever shared
    a database; it is now scoped to the rows the suite itself created. CI now
    runs all three: a `db-tests` job in `.github/workflows/ci.yml` boots a
    `timescale/timescaledb` service container, runs `bun run db:deploy`, then
    `packages/db`'s `test` and `apps/ingest`'s `test:db`.
  - `bun run db:seed` completes cleanly against the consolidated schema, and the
    three new columns are selectable through `interactive_events`.

2026-08-21 folded the
`disallowed_model` alert seed (P10-005) into `0001_init.sql`'s existing
disabled-by-default seed block rather than leaving it as a second numbered file,
and verified the Prisma layer against a regenerated one: pushing `schema.prisma`
into a throwaway database and diffing it back produced **118 statements matching
the committed migration exactly**, differing only in statement order and in
explicit `ASC` on index columns (the default, and an artifact of the
introspection route). Both layers were then applied to an empty database from
scratch to confirm they still stand alone.

**Squashed twice before that, both times pre-deployment.** 2026-08-18 folded the P13-012 and
P13-013 files back in, and collapsed the Prisma layer to a single regenerated
`20260814000000_init` — so the two layers are one file each again. Verified rather
than assumed: a `pg_dump` diff of the pre- and post-squash schemas over 1054
normalized lines showed **one** difference, the physical column order of `scores`
(`period_start`/`period_end` now sit in schema-declaration order instead of
appended at the end, which is what folding an `ALTER` into a `CREATE` does).
Indexes and constraints were byte-identical, and the sole writer
(`scoreUpsertSql`) names its columns explicitly, so nothing depends on position.

**Squashed 2026-08-14, pre-deployment**, from nine incremental files. The old chain
created the three continuous aggregates and then dropped and recreated them twice
more within the same deploy (`0001` → `0005` → `0008`). That was slow, it destroyed
materialized history that only a manual `refresh_continuous_aggregate` could
rebuild, and it **intermittently failed the deploy outright** with
`tuple concurrently deleted` when Timescale's background workers raced the second
rebuild. Defining each aggregate once removed all three problems, and the resulting
schema was verified byte-identical to the one the old chain produced.

Add a **new numbered file** for any future change rather than editing this one or
re-dropping anything in it. That four squashes happened is not a standing licence:
each was an explicit owner decision, taken while nothing was deployed anywhere.
The moment this schema exists in an environment, folding stops being free — an
edit to an applied file is invisible to Prisma's name-based idempotency check and
never runs.

### ⚠️ After a squash, every existing local database MUST be reset

**This is not optional and it fails silently.** `applySqlMigrations()` skips any
filename already recorded in `_db_sql_migrations`. An existing database has
`0001_init.sql` recorded, so the rewritten file **will not re-run**, and the
deleted `0002`/`0003`/`0004` are already recorded too. The result of *not*
resetting is a database that still has the right columns (from the old `0003` /
`0004`) but is now indistinguishable, to the migration runner, from a fresh one —
and any future edit to `0001` will silently never reach it. Do not try to repair
this by deleting rows from `_db_sql_migrations`: that re-runs the whole init file
against a populated database. **Reset:**

```bash
bun run docker:infra:down:v   # DESTRUCTIVE — wipes ./data (Postgres + MinIO + Grafana)
bun run docker:infra:up
bun run db:deploy
bun run db:seed               # optional
```

The same applies to any database not managed by the compose stack: drop it and
re-run `bun run db:deploy` against an empty one.

`sql/prototypes/` is **not applied by anything** — `prototype_semantic_search.sql` is
the gated pgvector spike declined in P7-007. Leave it out of the numbered sequence.

## Conventions

- **Enums are `UPPER_SNAKE_CASE`** (`OrgRole.ORG_ADMIN`, `AgentType.CLAUDE_CODE`).
  `packages/schemas` uses the same casing, so `agent_type` flows hook → ingest → DB
  with no translation layer. Don't add one.
- **`AgentType` has three definitions that must agree**: `AGENT_REGISTRY` in
  `packages/schemas`, the Prisma enum here, and the init migration's `CREATE TYPE`.
  `test/agent-type-parity.test.ts` fails if they drift — it reads the migration as
  TEXT on purpose, because Prisma's name-based idempotency check cannot see an
  edited-after-applied migration (see the drift trap above). **Append** new values;
  reordering rewrites the on-disk Postgres enum.
- **Forward-only.** Never edit a merged migration; backfills are their own file.
- **The seed may only write columns a producer writes.** `src/seed.ts` is the
  data almost every review, demo and screenshot is taken against, so a column it
  fabricates makes a query filtered on that column look alive right up until it
  meets real telemetry. That is not hypothetical: seeding `model` onto
  `PostToolUse` rows kept six routing reads — including an enabled alert — dead
  and unnoticed for the whole life of the feature (P14-005). The per-turn LLM
  columns (`model`, the four token counts, `cost_usd`) belong on the `Stop` that
  closes a turn and nowhere else; `test/seed-event-shape.test.ts` fails if one
  reappears elsewhere.
- **The seed may not reimplement a derived number either.** Same failure mode
  from the other direction: a seed that recomputes production's arithmetic
  locally produces numbers that agree with the queries reviewed against them and
  with nothing else. So `finalizeTelemetry()` gets `events.attributed_cost_usd`
  and `events.downstream_cost_usd` by calling `computeSessionAttribution` from
  `packages/schemas` — the same function `apps/ingest`'s
  `compute-cost-attribution` job calls (P14-011) — exactly as it gets
  `tool_category` from the shared `toolCategory()` (P14-002). The two columns are
  **two lenses on the same dollars, never additive**, neither may feed
  `sessions.total_cost_usd`, `pr_rollups.total_cost_usd` or a cost cagg, and NULL
  means *not attributed*, never $0.00. `test/seed-cost-attribution.test.ts` binds
  all of that to the seed's write path.
- `prisma migrate dev` needs the Prisma engine download, which is **egress-blocked in
  CI sandboxes**. Regenerate locally, commit the result.
- Scripts take `--env-file=../../.env`; `db:generate` deliberately runs with
  `DATABASE_URL=dummy` so it works with no database up.
