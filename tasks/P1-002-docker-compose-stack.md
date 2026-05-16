---
id: P1-002
title: docker-compose dev stack
phase: 1
workstream: A
status: ready
owner: null
depends_on: [P1-001]
blocks: [P1-012]
estimate: M
---

## Goal

A single `docker compose up` from a clean clone produces a working local stack: TimescaleDB-on-Postgres, MinIO, and (later, via overrides) the ingest and web apps. Local devs use this for everything.

## Context

- `PLAN.md` §1 commits to MinIO and docker-compose.
- Ingest (P1-008) and web (P1-024) will mount in via override files later; this task only ships the data services and a migrations-runner placeholder.

## Acceptance criteria

- [ ] `infra/docker-compose.yml` defines services:
  - `postgres` — image `timescale/timescaledb:latest-pg16`, healthcheck via `pg_isready`, exposes 5432.
  - `minio` — image `quay.io/minio/minio`, healthcheck via `/minio/health/live`, exposes 9000 + console 9001.
  - `createbuckets` — one-shot init that creates the `transcripts` bucket via `mc`.
  - `migrations` — placeholder service that exits 0 (real impl in P1-004).
- [ ] Persistent volumes for postgres data and minio data; survives `docker compose down` (but not `down -v`).
- [ ] Environment variables read from `.env` at repo root; `.env.example` updated with `POSTGRES_*`, `MINIO_*`, `S3_*` vars.
- [ ] `pnpm dev:stack` (root script) wraps `docker compose -f infra/docker-compose.yml up -d`.
- [ ] `pnpm dev:stack:down` and `pnpm dev:stack:logs` wrappers exist.
- [ ] README section at the root explains how to bring the stack up.
- [ ] Compose file is lint-clean per `docker compose config`.

## Implementation notes

- Use named volumes (`postgres_data`, `minio_data`) not bind mounts — Linux/macOS portability.
- Set `POSTGRES_INITDB_ARGS: "--encoding=UTF-8 --locale=C"`.
- Add `shared_preload_libraries=timescaledb` via a `command:` override.
- MinIO root creds in `.env.example` are placeholders; document that prod uses real creds.
- The `createbuckets` service should `mc alias set local http://minio:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD` then `mc mb --ignore-existing local/transcripts`.

## Files touched

- `infra/docker-compose.yml`
- `.env.example` (appended)
- `package.json` (root scripts)
- `README.md` (or `docs/local-dev.md`)

## Out of scope

- Migrations content (P1-003, P1-004).
- Ingest / web service definitions (added in later override files).
- Homelab / prod compose files.

## Verification

```bash
docker compose -f infra/docker-compose.yml config   # validates
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps       # all healthy
psql "postgres://postgres:postgres@localhost:5432/postgres" -c "SELECT 1;"
curl -s http://localhost:9000/minio/health/live      # 200
docker compose -f infra/docker-compose.yml down
```
