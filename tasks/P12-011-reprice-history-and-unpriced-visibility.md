---
id: P12-011
title: Reprice historical cost, and make unpriced models visible
phase: 12
workstream: B
status: done
owner: claude
depends_on: [P8-002, P8-006, P9-001, P12-010]
blocks: []
estimate: M
---

## Goal

Correcting a price table corrects history, and a model that no table prices says
so somewhere an operator will look.

## Context

P12-010 fixed six of the seven price tables. Two things were left open there, on
purpose, because both were decisions rather than oversights:

1. **No backfill.** `events.cost_usd` is written once, at ingest. Every row
   stored before that fix still carries the wrong number — Opus 4.6/4.7 sessions
   at 3× their real cost, every Codex turn at `$0`. P12-010 said `reconcile-cost`
   was "the existing surface for that decision"; on inspection it is not.
   `reconcile-cost` *compares* `SUM(events.cost_usd)` against a vendor bill and
   emits drift gauges. It has no write path and was never meant to have one.
2. **`gemini-3-pro-preview` has no sourceable rate**, so it bills `$0` — and the
   only signal was a Prometheus counter and an alert that reports a *count*. An
   operator told "73 events were unpriced" still has to grep ingest's logs to
   learn which model to add.

## Acceptance criteria

### Repricing

- [x] A `reprice-events` job recomputes `events.cost_usd` from the token counts
      already on each row, against the **current** price tables, resolving models
      through the same `resolveModelPrice` the ingest path uses (so the
      `<provider>/` prefix fallback cannot diverge between the two).
- [x] Two job names, one job: `reprice-events` reports only,
      `reprice-events-apply` writes. The manual-trigger endpoint takes no request
      body, so a `dryRun` flag had nowhere to live — and a destructive default is
      worse than two names.
- [x] The dry run logs per-model old total, new total, delta and event count, and
      writes nothing. Proven by a test asserting `$executeRaw` was never called.
- [x] Compressed chunks are handled. `events` compresses after 7 days, so most of
      the history this exists to fix is compressed: each chunk is decompressed,
      updated, and recompressed **only if it was compressed**, so a chunk the
      policy has not reached is not compressed early as a side effect.
- [x] `sessions.total_cost_usd` is recomputed from the repriced events. It is
      *accumulated* at ingest (`total_cost_usd + EXCLUDED.total_cost_usd`), never
      recomputed, so it cannot drift back into agreement on its own.
- [x] `pr_rollups.total_cost_usd` is recomputed through the same `computePRRollup`
      the webhook and manual-link paths use, so a repriced rollup is identical to
      one the normal path would have written.
- [x] `daily_cost_by_user` and `daily_cost_by_model` are refreshed over their whole
      range. Their policies only reach back 32 days, so without this the org
      dashboards would serve pre-reprice numbers for older buckets indefinitely.
      `daily_tool_usage` carries no cost column and is left alone.
- [x] Idempotent: `IS DISTINCT FROM` limits the UPDATE to rows whose cost actually
      moves, so a re-run after a partial failure rewrites nothing it already fixed.
- [x] An unpriced model is left at `$0`, not zeroed or guessed at — the P8-002 rule
      holds here too.
- [x] Verified against a real Postgres-Timescale, not just mocks: six DB-backed
      tests covering the compressed-chunk round trip (and that the chunk is left
      compressed), the aggregate refresh, the session recompute, idempotency, and
      the unpriced case. Gated on `DATABASE_URL` like
      `packages/db/test/schema.test.ts`, so CI without a database skips them.

### Unpriced-model visibility

- [x] `/admin/price-tables` leads with an **Unpriced models** table: agent, model,
      event count, input/output tokens, last seen, over a 90-day window.
- [x] The `unknown_model_surge` alert names the top models rather than only
      counting them. A model name is not individual-identifying, so this keeps the
      aggregate-only guarantee alerts are held to (P9-001).
- [x] A details blob written before `models` existed still renders — `alert_events`
      rows persisted by an older build replay through the same formatter.

## Implementation notes

Three things only a real database would have caught, all fixed against one:

- A bare parameter inside `format('%I.%I', …)` fails with 42P18 "could not
  determine data type of parameter $1". The `::text` casts are load-bearing.
- `decompress_chunk` returns `regclass`, which the Prisma driver cannot decode
  (`UnsupportedNativeDataType`). Hence `::text` on the result too.
- The chunk-scoped UPDATE filters on the chunk's **time range**, not `tableoid`.
  A `ts` predicate is what Timescale's chunk exclusion understands; a `tableoid`
  filter would scan the whole hypertable once per chunk.

The DB test passes an error-capturing logger and asserts nothing was logged.
`withJobRun` catches and logs, so without that a broken statement shows up as
"nothing changed" — which is exactly how the first two bugs above presented.

Repricing is deliberately **unwindowed**. A partial reprice would leave any
session straddling the boundary with a total summed from a mix of old and new
rates — wrong in a way nothing downstream would catch.

## Files touched

- `apps/ingest/src/jobs/reprice-events.ts` (new) + `test/reprice-events.test.ts`
  (mocked control flow) + `test/reprice-events.db.test.ts` (DB-backed SQL)
- `apps/ingest/src/jobs/scheduler.ts`, `src/index.ts` — registration and the
  price-table registry the job needs
- `apps/ingest/src/lib/cost.ts` — `resolveModelPrice` exported so the job and the
  ingest path cannot disagree about which row a model resolves to
- `apps/ingest/src/jobs/evaluate-alerts.ts`, `src/lib/notify/payload.ts` +
  `test/alert-notify.test.ts` — the alert names the models
- `apps/web/src/lib/unpriced-queries.ts` (new),
  `apps/web/src/app/admin/price-tables/page.tsx`
- `DESIGN_DOC.md` §6.5 job table + §6.7, `apps/ingest/AGENTS.md`

## Out of scope

- **A price for `gemini-3-pro-preview`.** Google's pricing page no longer carries
  a row for it (superseded by `gemini-3.1-pro-preview`) and Vertex's page is not
  fetchable here. Third-party aggregators quote $2/$12, but the tables cite
  primary sources with retrieval dates and that convention is worth more than one
  model's row. It stays unpriced and now says so on `/admin/price-tables`.
- Scheduling the reprice. Rewriting historical cost is an operator decision.
- A per-event record of *which* table version priced it. That would make
  repricing unnecessary for reporting, but it is a schema change and a much
  larger design question (`P8-002` deliberately keyed on version-in-filename).

## Verification

```bash
bun run --cwd apps/ingest test                                   # DB tests skip
DATABASE_URL=postgresql://… bun run --cwd apps/ingest test        # DB tests run
bun run check && bun run typecheck && bun run build && bun run test
```
