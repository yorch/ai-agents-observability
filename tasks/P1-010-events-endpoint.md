---
id: P1-010
title: POST /v1/events handler
phase: 1
workstream: B
status: blocked
owner: null
depends_on: [P1-008, P1-006, P1-004, P1-009]
blocks: [P1-011, P1-021]
estimate: M
---

## Goal

`POST /v1/events` accepts an `EventsBatch`, validates it, idempotently inserts into the `events` hypertable, and returns the count of newly-stored rows.

## Context

- `DESIGN_DOC.md` §6.3 (payload), §6.5 (identity), §8.1 (events schema).
- Batches are typically 1–50 events. Bound max batch size to prevent DoS.
- Idempotency via `event_id` UNIQUE constraint — duplicate retries are silent no-ops.

## Acceptance criteria

- [ ] Endpoint at `POST /v1/events`.
- [ ] Body parsed and validated against `EventsBatch` from `@pkg/schemas`. Returns 400 with Zod error report on failure.
- [ ] Max 500 events per batch; max 1 MB body size. 413 if exceeded.
- [ ] `session_context.git` parsed; `Repo` row lazy-upserted on `(host, owner, name)`.
- [ ] Identity claim per event normalized via `verifyIdentityClaim` (P1-009).
- [ ] Events inserted in a single COPY or batched `INSERT ... ON CONFLICT (event_id) DO NOTHING`.
- [ ] Cost recomputed server-side from price-table version baked into the request (defense in depth: never trust client cost arithmetic for billing-ish numbers).
- [ ] Response: `{ accepted: <int>, deduped: <int>, request_id: <uuid> }`. 202 on success.
- [ ] Metrics emitted: `ingest.events.accepted`, `ingest.events.deduped`, `ingest.events.duration_ms`.
- [ ] Integration test: insert a batch of 100 events, assert hypertable row count grew by 100; resubmit same batch, assert 0 new rows.

## Implementation notes

- Use a single transaction per batch.
- Bun's Postgres driver (`postgres.js` works fine) — pool size 10 for v1.
- Don't insert one-by-one; use `pg-copy-streams` or the multi-row INSERT pattern. Measure both.
- Cost recomputation needs the price table — load it once on boot via `GET /v1/price-table` internally (or import the static JSON).

## Files touched

- `apps/ingest/src/routes/events.ts`
- `apps/ingest/src/lib/insert-events.ts`
- `apps/ingest/src/lib/cost.ts`
- `apps/ingest/test/events.integration.test.ts`

## Out of scope

- Session aggregation (P1-011 — runs after insert).
- Streaming uploads (events are small; transcripts are P1-012).

## Verification

```bash
bun --filter '@app/ingest' test
# Manual:
curl -sX POST http://localhost:4000/v1/events \
  -H 'Authorization: Bearer <hook-token>' \
  -H 'Content-Type: application/json' \
  --data @apps/ingest/test/fixtures/events-batch.json
```
