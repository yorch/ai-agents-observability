---
id: P4-010
title: Grafana dashboard config
phase: 4
workstream: D
status: ready
owner: —
depends_on: [P4-009]
blocks: []
estimate: M
---

## Goal

Grafana (or equivalent) dashboards for ops: per-service QPS, error rate, latency percentiles, DB connection pool, MinIO usage. Linked from runbooks.

## Acceptance criteria

- [ ] Dashboard JSON/YAML provisioned in `infra/grafana/dashboards/`
- [ ] Panels: ingest QPS + error rate + p50/p99 latency, web page load times, github-app webhook delivery rate, Postgres connection pool, MinIO disk usage
- [ ] Alert rules: ingest p99 > 200ms for 5min, web 5xx rate > 1%, DB connections > 80% pool
- [ ] Linked from `docs/on-call.md` and each runbook
- [ ] Grafana container added to `docker-compose.infra.yml` (dev only)

## Notes

Grafana provisioning config lives in `infra/grafana/`. Consider Grafana Alloy for metrics scraping since pino logs are structured JSON — parse them into metrics with the Alloy log-to-metrics processor.

## Out of scope

- Production-grade high-availability Grafana setup (that's Platform/SRE's call)
- Custom Grafana plugin development
