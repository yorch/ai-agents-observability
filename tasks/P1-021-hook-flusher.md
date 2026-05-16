---
id: P1-021
title: Background flusher
phase: 1
workstream: D
status: blocked
owner: null
depends_on: [P1-020, P1-010]
blocks: []
estimate: M
---

## Goal

A long-running background process drains the SQLite queue and POSTs batches to `/v1/events`. It runs as a launchd/systemd service installed by `claude-telemetry install`, with exponential-backoff retry and crash-safe progress.

## Context

- `DESIGN_DOC.md` §6.2: offline-first, periodic flush.
- Cadence: every 5s or 50 events, whichever comes first.
- Must survive ingest being down for arbitrary periods.

## Acceptance criteria

- [ ] `claude-telemetry flusher` subcommand starts a loop:
  1. SELECT up to 100 events where `attempts < 10` ordered by ts.
  2. POST as a batch to `/v1/events` with the hook token.
  3. On 2xx: DELETE successful rows.
  4. On 5xx / network error: increment `attempts`, set `attempted_at`, back off (1s, 2s, 4s, …, max 5min).
  5. On 4xx (other than 401): log + DELETE (data we'll never accept).
  6. On 401: log + exit non-zero (prompts re-login).
- [ ] Flush cadence: 5s idle interval; immediate flush if queue length ≥ 50.
- [ ] Crash-safe: if killed mid-flush, retry picks up the same rows next start (no duplicate inserts because of `event_id` idempotency on the server).
- [ ] Service files:
  - `apps/hook/install/launchd/com.claude.telemetry.flusher.plist` (macOS).
  - `apps/hook/install/systemd/claude-telemetry.service` (Linux).
- [ ] `claude-telemetry install` (P1-023) installs the service files.
- [ ] `claude-telemetry status` shows: queue depth, last flush time, last error.
- [ ] Test: spin up a fake ingest endpoint, generate 1000 events in the queue, run flusher for 30s, assert all events reach the fake endpoint.

## Implementation notes

- Use `fetch` (Bun's native) with a 30s timeout.
- Backoff jitter ±20% to avoid thundering herd.
- Service files use the user's binary path; install command writes them with substitutions.
- For systemd: install as a user unit (`systemctl --user`), not system-wide.

## Files touched

- `apps/hook/src/flusher.ts`
- `apps/hook/src/lib/backoff.ts`
- `apps/hook/install/launchd/*.plist`
- `apps/hook/install/systemd/*.service`
- `apps/hook/test/flusher.test.ts`

## Out of scope

- Transcript flushing (P1-022 has its own path).
- Network-quality detection / adaptive batching.

## Verification

```bash
pnpm --filter=@app/hook test
# Manual:
./apps/hook/dist/claude-telemetry-<triple> flusher &
# Generate hook events; observe events in DB and rows draining.
```
