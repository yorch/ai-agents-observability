# On-Call Guide

## Overview

This document covers the on-call rotation, escalation paths, and quick-access links for
`ai-agents-observability`. Pair it with the service-specific runbooks in `docs/runbooks/`.

---

## Quick Links

| Tool | Dev (local) | Prod |
|---|---|---|
| Grafana | http://localhost:3001 | `$GRAFANA_URL` (environment-specific) |
| Prometheus | http://localhost:9090 | `$PROMETHEUS_URL` (environment-specific) |
| MinIO Console | http://localhost:9001 | managed S3 in prod |

---

## Grafana

**Dev:** http://localhost:3001

Grafana is provisioned automatically when you run `bun run docker:infra:up`. Log in with
`admin` / `admin` (configurable via `GRAFANA_PASSWORD` env var). Anonymous viewer access is
enabled, so dashboards are readable without logging in.

**Prod:** The production URL is environment-specific. Set `GRAFANA_URL` in your team's runbook
or ops wiki. Authentication in prod should be configured with a real identity provider — disable
`GF_AUTH_ANONYMOUS_ENABLED` and set `GF_SECURITY_ADMIN_PASSWORD` to a strong secret.

**Available dashboards:**

- **Ingest Service** — QPS, error rate, p50/p99 latency, events ingested rate, transcripts stored.

---

## Prometheus

**Dev:** http://localhost:9090

Scrapes:
- `ingest` service at `host.docker.internal:4000/metrics` every 15 s
- `github-app` service at `host.docker.internal:4001/metrics` every 15 s
- `web` service at `host.docker.internal:3000/metrics` every 15 s
- `prometheus` itself at `localhost:9090`

Retention: 15 days (configurable in `infra/prometheus/prometheus.yml`).

---

## Services and Owners

| Service | Port (dev) | Primary runbook |
|---|---|---|
| `apps/ingest` | 4000 | `docs/runbooks/ingest-down.md` |
| `apps/web` | 3000 | — |
| `apps/github-app` | 4001 | `docs/runbooks/webhook-failing.md` |
| Postgres / TimescaleDB | 5432 | `docs/runbooks/timescale-slow.md` |
| MinIO | 9000 / 9001 | `docs/runbooks/minio-full.md` |

---

## Escalation Path

1. **On-call engineer** — first responder. See runbook for the affected service.
2. **Team lead** — escalate after 30 min without mitigation or if the incident is data-loss risk.
3. **Vendor support** — Timescale Cloud (if on managed DB), AWS (if on S3).

Response-time expectations and rotation cadence are maintained in the team's ops wiki.

---

## SLOs (target)

| Service | Availability | Latency |
|---|---|---|
| `apps/ingest` | 99.5% | p99 < 200 ms |
| `apps/web` | 99% | p95 < 1 s |
| Webhook delivery | 99% | — |

See `tasks/P4-009-slos.md` for full error budget definitions.
