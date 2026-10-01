---
id: P15-002
title: On-demand install mode — a detached drainer instead of a resident service
phase: 15
workstream: D
status: review
owner: claude
depends_on: [P1-021, P1-022]
blocks: []
estimate: L
---

## Goal

An additional install mode for developers who do not want a launchd/systemd
service (the macOS Login Items prompt, a permanent background process, battery):
`aiot install --mode on-demand` registers no service units, and after agent
activity the hook starts a short-lived detached `aiot drain`. It keeps everything
the resident mode keeps — client-side redaction, transcript shipping, git/PR/team
enrichment, resumable uploads. `resident` stays the default.

## Context

Decided by the owner. Lossy tiers (agent-native HTTP hooks / OTel) are explicitly
out of scope, and Windows stays unsupported. The design survived an adversarial
review; the decisions that are not obvious are recorded in
[`apps/hook/AGENTS.md`](../apps/hook/AGENTS.md) ("On-demand mode"). Depends on the
delivery-reliability fixes in `fix/hook-delivery-reliability` (age-based expiry,
network errors not counting toward `MAX_ATTEMPTS`, 401 handling, `AIOT_TOKEN`,
`SessionEnd` capture, purge of `-wal`/`-shm`, `busy_timeout`).

## Acceptance criteria

- [x] **Leases.** Two rows in `queue.db` (`events`, `transcripts`) taken atomically (`UPDATE ...
      WHERE expires <= now RETURNING`), TTL 15 s, renewed every 5 s, freed by expiry after a
      crash; the resident flusher (`events`), resident shipper and `aiot import`
      (`transcripts`) and `aiot drain` (`events`, plus `transcripts` when free) take them; a
      service that cannot get its lease
      retries in seconds. Losing one aborts in-flight requests. Tested with real child
      processes, including a SIGKILLed holder, a holder that outlives the TTL, and a forced
      loss mid-batch and mid-upload.
- [x] **Spawn rules.** Only after Stop / SubagentStop / SessionEnd with something enqueued, or
      SessionStart; never from Pre/PostToolUse, while paused, or in resident mode; a claim
      query on the open connection decides (and dedupes a burst); detached, stdio on
      `/dev/null`, cwd = telemetry home, allowlisted environment.
- [x] **`aiot drain`** is one pass (events, then transcripts) and exits on nothing due, first
      transport failure, no token, a rejected token, 401, or the 120 s cap; never sleeps waiting.
      It re-checks for work before and after releasing the lease, so a hook that fires mid-pass
      (SessionEnd after the last Stop) is delivered. `--wait` is the foreground variant and
      exits non-zero when data remains.
- [x] **Retry state on disk** (`next_attempt_at` on queue rows and ship markers); only real
      server responses count toward `MAX_ATTEMPTS`.
- [x] **Enrich once**: enrichment is written back and reused by retries — but a row is marked
      final only when its GitHub lookups answered, so an event captured offline is not stored
      as "no PR".
- [x] **Transcript cadence** in drain mode: SessionEnd, idle (5 min), or `last_shipped_at`
      older than 10 min — not every Stop. The resident shipper's cadence is unchanged.
- [x] **`install --mode`** writes no units / runs no service manager in on-demand mode; a mode
      switch stops and removes the other mode's units and the lease holder; install fails
      loudly (and wires nothing) when the mode cannot be recorded, and the mode is recorded
      BEFORE any unit is removed. `uninstall` resets the mode, then stops the lease holder;
      `purge-local` stops it and keeps the mode.
- [x] **`aiot status`** in on-demand mode shows mode, age of the oldest queued row, last clean
      drain, lease holder and depth instead of the heartbeat warning.
- [x] **Docs** state the limits plainly (`apps/hook/README.md`, `docs/deploy/hook-binary.md`)
      and give the container recipe.

## Implementation notes

- New: `lib/lease.ts`, `lib/queue-schema.ts` (versioned in-place migration), `lib/drainer-spawn.ts`,
  `lib/binary-path.ts`, `commands/drain.ts`. `flusher.ts` / `shipper.ts` gain `flushOnce` /
  `shipPass`, which the resident loops and `drain` both call.
- A bug found by the contention test and fixed here although it predates this task: the
  shipper treated chunk-progress writes as "the marker was rewritten" for every multi-chunk
  upload. On main that costs ONE redundant full upload plus a 409 per multi-chunk transcript
  and then self-heals; it is not a loop. The fix (compare the hook-stamped `updated_at`,
  and skip progress/failure writes over a rewritten marker) landed on main as #261; this
  branch builds on it and adds only `markShipFinal` bumping `updated_at` and resetting
  resume state.
- `AGENTS.md` carries the "Resident mode: what changed" table — the complete list of
  differences resident installs see.

## Files touched

- `apps/hook/src/{hook-entry,flusher,shipper,cli}.ts`
- `apps/hook/src/commands/{drain,install,uninstall,purge,status,import}.ts`
- `apps/hook/src/lib/{lease,queue-schema,queue,queue-reader,drainer-spawn,binary-path}.ts`
- tests: `lib/lease.test.ts`, `lib/queue-schema.test.ts`, `commands/{drain,install,on-demand-commands}.test.ts`,
  `on-demand.e2e.test.ts` (+ `lib/e2e-harness.ts`)
- docs: `apps/hook/{README,AGENTS}.md`, `docs/deploy/hook-binary.md`

## Out of scope

- Agent-native HTTP hooks / OTel as a delivery tier (lossy).
- Windows.
- A "stop the lease holder" mechanism for processes that are not aiot binaries (refused by design).

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test
# The compiled-binary suite on its own (builds the runtime; uses the Rust launcher if cargo exists):
bun test --cwd apps/hook src/on-demand.e2e.test.ts
```
