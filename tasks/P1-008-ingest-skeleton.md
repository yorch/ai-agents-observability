---
id: P1-008
title: apps/ingest skeleton (Bun + Hono)
phase: 1
workstream: B
status: blocked
owner: null
depends_on: [P1-001]
blocks: [P1-009, P1-010, P1-012, P1-013]
estimate: S
---

## Goal

Stand up the ingest service as a Bun + Hono app with health endpoint, structured logging, and a Dockerfile usable by docker-compose. Subsequent tasks add real endpoints.

## Context

- `PLAN.md` §2 puts ingest at `apps/ingest`. Pinned versions: Bun 1.3.13, Hono 4.12.x, pino 10.x.
- Hono is used for routing; runs natively on Bun.
- Separate from web because SLOs differ (ingest is hot path).

## Acceptance criteria

- [ ] `apps/ingest/src/index.ts` boots a Hono app on a configurable port (`INGEST_PORT`, default 4000).
- [ ] `GET /healthz` returns `{ ok: true, version: <git sha>, uptime_s: <number> }`.
- [ ] `GET /readyz` returns 200 only if Postgres + MinIO health checks pass; 503 otherwise.
- [ ] Structured logging via `pino` with request-id middleware.
- [ ] Graceful shutdown: SIGTERM drains in-flight requests up to 10s, then exits.
- [ ] `apps/ingest/Dockerfile` builds a Bun image, multi-stage with a slim final.
- [ ] `infra/docker-compose.override.yml` wires the service in for local dev with hot reload.
- [ ] `bun --filter '@app/ingest' dev` starts the service with `bun --watch`.
- [ ] Integration smoke test: HTTP GET `/healthz` returns 200 in test.

## Implementation notes

- Read env via Zod-validated config module at `src/config.ts`. Fail fast on bad config.
- Don't use `bun:sqlite` here — ingest talks to Postgres only.
- `pino-pretty` only in dev (NODE_ENV check), JSON in prod.

## Files touched

- `apps/ingest/src/index.ts`
- `apps/ingest/src/config.ts`
- `apps/ingest/src/middleware/{logger,request-id}.ts`
- `apps/ingest/Dockerfile`
- `apps/ingest/test/health.test.ts`
- `infra/docker-compose.override.yml`
- `.env.example` (appended)

## Out of scope

- Auth (P1-009).
- Any business endpoints (P1-010+).

## Verification

```bash
bun --filter '@app/ingest' dev &
curl -s http://localhost:4000/healthz | jq .ok
docker compose -f infra/docker-compose.yml -f infra/docker-compose.override.yml up --build ingest
bun --filter '@app/ingest' test
```
