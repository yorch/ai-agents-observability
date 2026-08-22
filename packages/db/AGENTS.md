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

**One file per layer, and that is the invariant.** The relational layer is a
single Prisma-generated migration; the custom layer is a single SQL file. A change
to `schema.prisma` is regenerated into the former, never hand-patched into it, and
anything Prisma cannot model goes in the latter — not folded into the Prisma
migration, where the next regeneration would drop it.

Current files:

- `0001_init.sql` — everything Prisma cannot model, in one file: the `events`
  hypertable (all columns, including `run_kind`, `notification_kind`,
  `tool_target_hash` and `tool_action`) with its indexes, compression and retention
  policies; the three continuous aggregates, each defined **once** and already
  filtered to `run_kind = 'INTERACTIVE'`; the `transcript_index` FTS table with its
  generated `tsvector`; two things Prisma cannot express on a Prisma-managed table
  (the partial `sessions_run_kind_idx`, and `NOT NULL` on the `redaction_flags`
  scalar list); the built-in alert-rule seeds; the `scores` unique index, which
  needs `NULLS NOT DISTINCT` (P13-013) and so has no `@@unique` in
  `schema.prisma` at all; and the `interactive_sessions` / `interactive_events`
  views that carry the `run_kind` guard (P13-012).

**Squashed three times, all pre-deployment.** 2026-08-21 folded the
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
re-dropping anything in it. That both squashes happened is not a standing licence:
each was an explicit owner decision, taken while nothing was deployed anywhere.
The moment this schema exists in an environment, folding stops being free — an
edit to an applied file is invisible to Prisma's name-based idempotency check and
never runs.

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
- `prisma migrate dev` needs the Prisma engine download, which is **egress-blocked in
  CI sandboxes**. Regenerate locally, commit the result.
- Scripts take `--env-file=../../.env`; `db:generate` deliberately runs with
  `DATABASE_URL=dummy` so it works with no database up.
