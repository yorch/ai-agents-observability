---
id: P2-009
title: Webhook delivery health metrics
phase: 2
workstream: F
status: done
owner: null
depends_on: [P2-002]
blocks: []
estimate: S
---

## Goal

The `github-app` service tracks per-event-type delivery counts, failure counts, and processing latency. An internal `GET /admin/health` endpoint surfaces the live state. No external monitoring service required for Phase 2.

## Context

- `PLAN.md` §3 Phase 2 — "Webhook receipt rate, failure rate, retry count. Surface on an internal `/admin/health` view; alerts in Phase 4."
- This is observability for the webhook pipeline itself — distinct from the main `/health` liveness check (already in P2-002).
- Phase 4 will plug these metrics into a proper monitoring stack. For now, in-memory counters + DB row are sufficient.

## Acceptance criteria

- [ ] In-memory counters (reset on restart — acceptable for Phase 2):
  - `deliveries_received` per event type
  - `deliveries_processed` per event type (handler completed without error)
  - `deliveries_failed` per event type (handler threw)
  - `p99_processing_ms` per event type (rolling window, last 1000 deliveries)
- [ ] Each webhook handler is wrapped to record start time, catch errors, and increment counters.
- [ ] A `WebhookDelivery` DB record is written per delivery: `(delivery_id, event_type, action, repo, received_at, processed_at, status: 'ok'|'error', error_text)`. Delivery ID from `X-GitHub-Delivery` header.
  - Add `WebhookDelivery` model to Prisma schema + migration.
  - Retention: delete rows older than 30 days via a cron job in the github-app scheduler (mirrors the ingest abandoned-session sweep pattern).
- [ ] `GET /admin/health` (no auth — localhost only; bind on loopback for Phase 2):
  - Returns JSON: `{ uptime_s, deliveries: { [event_type]: { received, processed, failed, p99_ms } } }`.
  - If `X-Admin-Secret` header is present and matches `ADMIN_SECRET` env var, return extended info including last 10 failed deliveries with error text.
- [ ] Test: send 3 mock webhooks (2 succeed, 1 fails); assert counters match.

## Implementation notes

- A simple `Map<string, Counter>` in module scope is fine for in-memory counters. No need for a metrics library (Prometheus, etc.) yet.
- The p99 rolling window: keep a circular buffer of the last 1000 durations per event type. Sort and take the 990th element.
- `WebhookDelivery` writes are best-effort — if the DB write fails, log it but don't fail the delivery ACK (202).
- `ADMIN_SECRET` in `.env.example` (optional; if absent, `/admin/health` returns only the basic counters).

## Files touched

- `apps/github-app/src/lib/metrics.ts` (new: in-memory counters + rolling p99)
- `apps/github-app/src/routes/health.ts` (extend existing health route)
- `apps/github-app/src/routes/admin.ts` (new: `/admin/health`)
- `apps/github-app/src/middleware/track-delivery.ts` (new: wraps handlers)
- `packages/db/prisma/schema.prisma` (add `WebhookDelivery` model)
- `packages/db/prisma/migrations/<ts>_webhook_delivery/migration.sql`
- `apps/github-app/test/metrics.test.ts` (new)
- `.env.example` (add `ADMIN_SECRET`)

## Out of scope

- Prometheus / OpenTelemetry export (Phase 4).
- Alerting on failure rate thresholds (Phase 4).
- Auth on `/admin/health` beyond the optional secret header (Phase 4).

## Verification

```bash
bun --filter '@ai-agents-observability/github-app' test
# After a webhook delivery:
curl http://localhost:4001/admin/health | jq .
psql "$DATABASE_URL" -c "SELECT event_type, status, received_at FROM webhook_deliveries ORDER BY received_at DESC LIMIT 10;"
```
