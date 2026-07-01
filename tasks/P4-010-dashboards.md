---
id: P4-010
title: Grafana dashboard config
phase: 4
workstream: D
status: done
owner: claude
depends_on: []
blocks: []
estimate: M
---

## Goal

Add Prometheus metrics to `apps/ingest`, provision Grafana with a pre-built Ingest Service
dashboard, and add operational runbooks + on-call doc. After this task, `bun run docker:infra:up`
starts Prometheus (`:9090`) and Grafana (`:3001`) with the ingest dashboard visible immediately.

## Context

- `DESIGN_DOC.md` §12.4 — platform/SRE handoff deliverables.
- `tasks/P4-roadmap.md` — P4-010 is listed as "Dashboards (Grafana or similar)".
- `apps/ingest` already had `prom-client` in dependencies and the metrics module partially wired.

## Acceptance criteria

- [x] `apps/ingest/src/lib/metrics.ts` exports `registry`, `httpRequestsTotal`, `httpRequestDurationMs`, `eventsIngestedTotal`, `transcriptsStoredTotal`.
- [x] `GET /metrics` on `apps/ingest` returns Prometheus text exposition format.
- [x] The request-observability middleware (`middleware/logger.ts`) increments `httpRequestsTotal` and `httpRequestDurationMs` on every request, timed once alongside the `res` log.
- [x] `eventsIngestedTotal` is incremented in the events handler for each accepted event.
- [x] `transcriptsStoredTotal` is incremented in the transcripts handler after a successful S3 write.
- [x] `docker-compose.infra.yml` includes `prometheus` (`:9090`) and `grafana` (`:3001`) services with named volumes.
- [x] `infra/prometheus/prometheus.yml` scrapes ingest at `host.docker.internal:4000/metrics` every 15 s.
- [x] `infra/grafana/provisioning/datasources/prometheus.yml` provisions Prometheus as the default data source.
- [x] `infra/grafana/provisioning/dashboards/default.yml` provisions the dashboard folder.
- [x] `infra/grafana/dashboards/ingest.json` contains panels for QPS, error rate, p50/p99 latency, events ingested rate, and transcripts stored.
- [x] `docs/on-call.md` created with Grafana section pointing to `http://localhost:3001`.
- [x] Runbooks created: `ingest-down.md`, `minio-full.md`, `timescale-slow.md`, `oauth-broken.md`, `webhook-failing.md`.
- [x] Each runbook includes a "Grafana: http://localhost:3001 (see on-call.md)" line.
- [x] `bun run typecheck` passes.
- [x] `bun run check` passes (Biome clean).

## Implementation notes

- `prom-client` already present in `apps/ingest/package.json` at `15.1.3`.
- Ingest default port is `4000` (from `config.ts` — `INGEST_PORT` env var).
- Grafana port `3001` (host) → `3000` (container). Anonymous viewer access enabled for dev.
- `host.docker.internal` used in prometheus.yml so the containerised Prometheus can reach the Bun
  ingest server running on the host in dev mode.
- Dashboard JSON uses `schemaVersion: 39` (Grafana 10+ / 12 compatible).
- Named volumes for both `prometheus_data` and `grafana_data` — no bind mounts for data.

## Files touched

- `apps/ingest/src/lib/metrics.ts` — already existed; no changes needed.
- `apps/ingest/src/app.ts` — already had middleware + `/metrics` route; no changes needed.
- `apps/ingest/src/routes/events.ts` — already incremented counter; no changes needed.
- `apps/ingest/src/routes/transcripts.ts` — added `transcriptsStoredTotal.inc()` after S3 write.
- `docker-compose.infra.yml` — added `prometheus`, `grafana`, `prometheus_data`, `grafana_data`.
- `infra/prometheus/prometheus.yml` — new.
- `infra/grafana/provisioning/datasources/prometheus.yml` — new.
- `infra/grafana/provisioning/dashboards/default.yml` — new.
- `infra/grafana/dashboards/ingest.json` — new.
- `docs/on-call.md` — new.
- `docs/runbooks/ingest-down.md` — new.
- `docs/runbooks/minio-full.md` — new.
- `docs/runbooks/timescale-slow.md` — new.
- `docs/runbooks/oauth-broken.md` — new.
- `docs/runbooks/webhook-failing.md` — new.

## Out of scope

- Metrics for `apps/web` and `apps/github-app` (separate tasks).
- Alerting rules / Alertmanager config.
- Production Grafana auth / LDAP / SSO.
- Grafana dashboards for DB internals (Timescale) or MinIO storage metrics.

## Verification

```bash
# Type check
bun run typecheck

# Lint + format check
./node_modules/.bin/biome check --error-on-warnings .

# Start infra stack (requires Docker)
bun run docker:infra:up

# Verify Prometheus is up and scraping
curl http://localhost:9090/-/healthy

# Verify Grafana is up
curl http://localhost:3001/api/health

# Verify metrics endpoint (requires ingest running)
bun run --cwd apps/ingest dev &
curl http://localhost:4000/metrics | head -20
```
