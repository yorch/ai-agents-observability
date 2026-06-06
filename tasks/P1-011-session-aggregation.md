---
id: P1-011
title: Session aggregation upserts
phase: 1
workstream: B
status: done
owner: claude
depends_on: [P1-010]
blocks: [P1-025, P1-026]
estimate: M
---

## Goal

Every accepted event batch atomically updates the corresponding `Session` row's aggregates (event counts, token totals, cost, duration). The web UI reads from `Session` for fast per-user views without scanning the hypertable.

## Context

- `DESIGN_DOC.md` §8.2 defines `Session` fields including the aggregates.
- Updates must be atomic per session — concurrent batches for the same session must not lose counts.
- A session row is created on the first event seen with that `session_id`.

## Acceptance criteria

- [ ] After event insert, an upsert runs per `(session_id)` in the batch:
  - Sets immutable fields on insert (`started_at`, `user_id`, `repo_id`, `agent_type`, `session_context`).
  - On conflict, `SET event_count = event_count + N, input_tokens = input_tokens + N, ...` atomically.
  - Updates `last_event_at = greatest(last_event_at, max(ts in batch))`.
  - Sets `ended_at` if any event in batch has `event_type='session_end'`.
- [ ] `Session.status` transitions: `active` on first insert → `ended` when end event arrives → `abandoned` if `last_event_at > 24h ago` (managed by a periodic sweep, not this endpoint).
- [ ] Tool histogram (`Session.tool_usage jsonb`) merged in-place via `jsonb_set` or a server-side merge function. [deferred — see implementation note]
- [ ] Returns enriched response: `{ accepted, deduped, sessions_touched: <int> }`.
- [ ] Test: two concurrent batches for the same session don't double-count or lose updates (use repeatable-read isolation or `ON CONFLICT` with `SET col = col + EXCLUDED.col`).

## Implementation notes

- Prefer SQL-side accumulation (`SET event_count = sessions.event_count + EXCLUDED.event_count`) over read-modify-write — concurrency-safe without explicit locks.
- For the tool histogram, build a JSONB delta and use `jsonb_set` recursively, or write a `merge_tool_usage(jsonb, jsonb) RETURNS jsonb` PL/pgSQL function as part of the SQL migrations.
- An abandoned-session sweep is a cron in P1-018's worker, not part of this task — but document the contract.

> **As-built deviation**: `tool_usage jsonb` was not implemented. The session row tracks aggregate tool call / error / permission counts via explicit integer columns (`tool_call_count`, `tool_error_count`, `permission_deny_count`). Per-tool breakdown requires querying the `events` hypertable directly. The `0002_merge_tool_usage.sql` migration was not created. This was a deliberate simplification — add per-tool jsonb tracking as a follow-up task if the web UI needs it.

## Files touched

- `apps/ingest/src/lib/upsert-session.ts`
- `apps/ingest/src/routes/events.ts` (chained after insert)
- `packages/db/sql/migrations/0002_merge_tool_usage.sql` (PL/pgSQL helper)
- `apps/ingest/test/session-aggregation.test.ts`

## Out of scope

- Cross-session rollups (Phase 2).
- Abandoned-session sweep (P1-018).

## Verification

```bash
bun --filter '@app/ingest' test
# Manual:
# Submit two overlapping batches for the same session_id and verify counts.
```
