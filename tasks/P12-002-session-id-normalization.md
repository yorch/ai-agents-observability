---
id: P12-002
title: Session-ID normalization in the adapter seam
phase: 12
workstream: D
status: ready
owner: null
depends_on: [P8-003]
blocks: [P12-003, P12-004, P12-006, P12-008]
estimate: S
---

## Goal

Every adapter emits a valid UUID `session_id` for the same underlying agent session,
whatever that agent's native ID format is — fixing a live drop on opencode traffic and
immunizing the five adapters that follow.

## Context

**This is a bug, not just hardening.** `EventSchema` requires `session_id: z.uuid()`
(`packages/schemas/src/event.ts:85`), and ingest validates *per event* and drops the
invalid ones (`apps/ingest/src/routes/events.ts:71`) — deliberately tolerant, so a bad
event vanishes rather than failing the batch. Meanwhile `opencode.ts:101` passes
`raw.sessionID` straight through, and real opencode session IDs are **`ses_`-prefixed,
not UUIDs**. Live opencode sessions therefore ingest as nothing. The adapter test is
green because its fixtures use UUID-shaped strings
(`apps/hook/src/adapters/opencode.test.ts:26`).

The agents queued behind this have the same shape of problem: OMP session IDs are
16-char hex, Copilot's `sessionId` format is unspecified, and Codex's hook `session_id`
is a plain string by contract.

`uuidv5` already exists in the hook (`apps/hook/src/lib/uuid5.ts`, used for
deterministic import IDs), so this is a wiring task, not a crypto task.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §0.3.

## Acceptance criteria

- [ ] A shared `sessionUuid(agentType, nativeId)` helper lives in the seam: returns
      `nativeId` unchanged when it is already a valid UUID, otherwise a `uuidv5`
      derivation namespaced by agent type.
- [ ] The derivation is **stable** — the same `(agent, nativeId)` yields the same UUID
      across processes and runs — and **collision-safe across agents**: opencode
      `ses_abc` and omp `ses_abc` derive to different UUIDs.
- [ ] `opencode.ts` uses it; a test feeds a realistic `ses_`-prefixed ID and asserts
      the emitted event passes `EventSchema.safeParse`.
- [ ] Every existing adapter's emitted event is asserted to pass `EventSchema` in its
      own test — with a realistic native ID, not a UUID-shaped fixture. This is the
      criterion that would have caught the original bug.
- [ ] Claude Code output is unchanged: its `session_id` is already a UUID and passes
      through untouched.
- [ ] The nil-UUID fallback for a missing session ID keeps working (it is a valid UUID
      and must not be re-derived).

## Implementation notes

Namespacing by agent type is what prevents cross-agent collision; do it inside the
helper rather than trusting each caller to prefix.

Consider making the emitted-event `EventSchema` assertion a shared test helper that
every adapter test calls — the point is that no adapter can ship an event the ingest
route would drop.

## Files touched

- `apps/hook/src/adapters/index.ts` (or a new `apps/hook/src/adapters/session-id.ts`)
- `apps/hook/src/adapters/opencode.ts`, `codex.ts`, `claude-code.ts`
- their `.test.ts` siblings

## Out of scope

- Backfilling or remapping already-ingested opencode rows (there are none — the events
  never landed).
- Changing `EventSchema` to accept non-UUID session IDs. The UUID requirement is load-
  bearing across the DB and the transcript path; normalize at the edge instead.

## Verification

```bash
bun run --cwd apps/hook test
bun run check && bun run typecheck && bun run build && bun run test
```
