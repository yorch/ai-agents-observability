# Service Level Objectives

Version: 1.0 · Effective: 2026-06-06  
Owner: Dev Tools team → Platform/SRE (handoff target: Phase 4 completion)

---

## Overview

These SLOs define the measurable reliability targets for the ai-agents-observability platform. They are tracked for 30-day rolling windows. Error budgets gate Phase 4 ops handoff.

---

## Services

### apps/ingest — Telemetry Ingestion

| SLI | Target | Measurement |
|---|---|---|
| Availability | **99.5%** | `1 - (5xx_count / total_requests)` on `/v1/events` and `/v1/transcripts` |
| Latency (p99) | **< 200ms** | `POST /v1/events` response time at p99 |
| Latency (p50) | **< 50ms** | `POST /v1/events` response time at p50 |
| Event loss | **0%** | Events written to DB within 5 min of receipt (hook retry covers transient failures) |

**Error budget (30 days)**: 3.6 hours of < 99.5% availability.  
**Note**: Hook clients buffer locally (SQLite queue) and retry, so brief outages do not cause event loss. Availability SLO is for client experience, not data integrity.

---

### apps/web — Dashboard & API

| SLI | Target | Measurement |
|---|---|---|
| Availability | **99%** | `1 - (5xx_count / total_requests)` across all authenticated routes |
| Latency p95 | **< 1s** | `/me`, `/me/sessions`, `/team/[slug]` response time |
| `/me` p50 | **< 500ms** | Specifically the `/me` overview page (PLAN.md Phase 1 exit criterion) |

**Error budget (30 days)**: 7.2 hours of < 99% availability.

---

### apps/github-app — GitHub Webhooks

| SLI | Target | Measurement |
|---|---|---|
| Delivery success | **99%** | `1 - (error_count / total_deliveries)` in `webhook_deliveries` table |
| Processing latency | **< 5s** | From webhook receipt to PR row upserted |

**Note**: GitHub retries failed deliveries for 72 hours; a brief outage is recoverable without permanent data loss.

---

### Scheduled Jobs

| Job | Schedule | Target completion | Alert threshold |
|---|---|---|---|
| `sync-teams` | Hourly | < 60s | > 5 min or 2 consecutive failures |
| `sweep-abandoned` | Every 10 min | < 30s | > 2 min or 3 consecutive failures |
| `run-deletions` | Every 6h | < 2 min | Any failure (GDPR obligation) |
| `sweep-retention` | Nightly 02:00 UTC | < 10 min | > 30 min or any failure |
| `index-transcripts` | Nightly 03:00 UTC | < 30 min | > 1h |
| `compute-effectiveness` | Nightly 04:00 UTC | < 15 min | > 45 min |

---

## Error Budget Policy

- **> 50% budget consumed in first 15 days**: engage Platform/SRE for review.
- **100% budget exhausted**: freeze non-critical deploys; incident post-mortem required within 3 business days.
- **GDPR run-deletions failures**: always P1 regardless of budget state — 30-day legal obligation.

---

## Measurement Notes

- Latency measured from access logs (pino structured logs, parsed by Grafana / your preferred log pipeline).
- Availability calculated from `/health` checks + 5xx error rates.
- SLI data retained for 12 months.
- SLO review cadence: quarterly, or after any incident that burns > 20% of budget.

---

## Future SLIs (Phase 4 additions)

- Org dashboard page p95 < 2s
- Transcript FTS query < 500ms
- Continuous aggregate refresh lag < 2h
