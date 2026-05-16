---
id: P1-004
title: Timescale events hypertable + migration runner
phase: 1
workstream: A
status: blocked
owner: null
depends_on: [P1-003]
blocks: [P1-005, P1-010]
estimate: M
---

## Goal

The `events` table exists as a TimescaleDB hypertable with the schema in `DESIGN_DOC.md` §8.1. A migration runner applies both Prisma migrations and raw Timescale DDL idempotently in the right order.

## Context

- Prisma can't manage hypertables; we keep this as a separate raw-SQL migration set.
- The runner is what `infra/docker-compose.yml` invokes for the `migrations` service (P1-002 ships a placeholder).
- The hypertable is the highest-volume table in the system; bad schema choices here cost the most.

## Acceptance criteria

- [ ] `packages/db/sql/migrations/0001_events_hypertable.sql` creates:
  - `events` table per §8.1 (columns: `event_id`, `ts`, `session_id`, `user_id`, `team_id`, `repo_id`, `agent_type`, `event_type`, `tool_name`, `model_name`, `input_tokens`, `output_tokens`, `cached_tokens`, `cost_usd`, `duration_ms`, `status`, `redaction_flags`, `payload jsonb`).
  - `SELECT create_hypertable('events', 'ts', chunk_time_interval => INTERVAL '1 day');`
  - Indexes: `(user_id, ts desc)`, `(session_id, ts)`, `(repo_id, ts desc)`, `(event_type, ts desc)`.
  - Unique constraint on `event_id` (UUID, client-generated for idempotency).
- [ ] Compression policy: `ALTER TABLE events SET (timescaledb.compress, ...); SELECT add_compression_policy('events', INTERVAL '7 days');`
- [ ] Retention policy placeholder commented (we use 1y for transcripts, indefinite for events; retention added in Phase 4 only if storage pressure surfaces).
- [ ] `infra/migrations-runner/Dockerfile` builds a small Node image bundling `@pkg/db`.
- [ ] `infra/migrations-runner/run.ts` (or shell script):
  1. Waits for Postgres ready (up to 60s).
  2. Ensures `CREATE EXTENSION IF NOT EXISTS timescaledb;`.
  3. Runs `prisma migrate deploy`.
  4. Applies any unrun files in `packages/db/sql/migrations/` (tracked via a `_db_sql_migrations` table).
- [ ] `docker compose up migrations` brings Postgres + extensions + tables to a known good state, idempotently.
- [ ] Integration test inserts 1000 events across 7 days and verifies hypertable chunks exist (`SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='events';` > 1).

## Implementation notes

- Prisma 7's `prisma db execute --file` is fine for applying single SQL files; the runner can shell out to it, or use a raw pg client (`postgres.js`). Either works — pick whichever keeps the runner image smaller.
- The `_db_sql_migrations` tracking table is simple: `(filename text primary key, applied_at timestamptz default now())`. Don't pull in a migration framework for this.
- Apply SQL files in lexicographic order. Wrap each in a transaction.
- Use BIGINT for token counts; cost as `NUMERIC(12, 6)` to avoid float drift.
- `redaction_flags` as `text[]` so it queries cleanly.
- TimescaleDB 2.26 caveat: the compose image is `pg17.2-ts2.26`. If anyone tries to swap to `pg17.1` or `pg16.5`, things break — see `PLAN.md` §6.

## Files touched

- `packages/db/sql/migrations/0001_events_hypertable.sql`
- `packages/db/src/sql-migrate.ts` (programmatic runner)
- `infra/migrations-runner/Dockerfile`
- `infra/migrations-runner/run.ts`
- `infra/docker-compose.yml` (wire `migrations` service to the new image)

## Out of scope

- Continuous aggregates (Phase 4).
- Read replicas.
- Cross-region replication.

## Verification

```bash
docker compose -f infra/docker-compose.yml up -d postgres
docker compose -f infra/docker-compose.yml run --rm migrations
psql "$DATABASE_URL" -c "\d events"
psql "$DATABASE_URL" -c "SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name='events';"
pnpm --filter=@pkg/db test
```
