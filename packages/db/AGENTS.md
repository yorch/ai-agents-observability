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
| 1. Relational | `prisma/migrations/20260625075457_init/` | `prisma migrate deploy` | Everything Prisma models |
| 2. Custom SQL | `sql/migrations/NNNN_*.sql` | `applySqlMigrations()` (`src/sql-migrate.ts`) | Everything it can't |

Layer 2 runs **after** layer 1, in filename order, and each file must be idempotent
(`IF NOT EXISTS`, `CREATE OR REPLACE`) — it re-runs on every stack boot.

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
`ALTER TABLE events ADD COLUMN IF NOT EXISTS …` is correct here and `0003` does exactly
that. What's forbidden is patching a **Prisma-managed** table from this layer to dodge
the reset above — that produces a schema Prisma can no longer regenerate.

Current files, as a sense of the range:

- `0001_init.sql` — hypertable, compression, retention, continuous aggregates
- `0002`, `0004`, `0006` — data seeds (built-in alert rules)
- `0003` — `ALTER TABLE events` + partial index (hypertable, not Prisma-managed)
- `0005` — redefines two continuous aggregates in place (DROP + CREATE, `WITH NO DATA`
  plus a policy; a cagg refresh cannot run inside the migration transaction)

`sql/prototypes/` is **not applied by anything** — `prototype_semantic_search.sql` is
the gated pgvector spike declined in P7-007. Leave it out of the numbered sequence.

## Conventions

- **Enums are `UPPER_SNAKE_CASE`** (`OrgRole.ORG_ADMIN`, `AgentType.CLAUDE_CODE`).
  `packages/schemas` uses the same casing, so `agent_type` flows hook → ingest → DB
  with no translation layer. Don't add one.
- **Forward-only.** Never edit a merged migration; backfills are their own file.
- `prisma migrate dev` needs the Prisma engine download, which is **egress-blocked in
  CI sandboxes**. Regenerate locally, commit the result.
- Scripts take `--env-file=../../.env`; `db:generate` deliberately runs with
  `DATABASE_URL=dummy` so it works with no database up.
