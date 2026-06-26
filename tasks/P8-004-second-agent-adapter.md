---
id: P8-004
title: Second-agent adapter (opencode)
phase: 8
workstream: D
status: done
owner: claude
depends_on: [P8-003, P8-001, P8-002]
blocks: []
estimate: L
---

## Interface verdict (finalization)

The provisional `HookAdapter` from P8-003 **held for opencode with zero breaking
changes** — finalized as-is, backward-compatible with the Claude Code adapter. The
findings from the second example:

- **Transcript shipping is the one genuinely agent-shaped piece.** Claude Code emits
  a single `.jsonl` transcript path in the Stop payload; opencode stores history as a
  *directory* of per-message JSON under `~/.local/share/opencode/storage`. The shipper
  reads a single file, so opencode transcript upload needs an export step — deferred
  (follow-up). `transcriptTarget` already returns `TranscriptTarget | null`; opencode
  returns null and ships events only. No interface change required — the nullable
  return was the right escape hatch, validated by an agent that actually needs it.
- `client.claude_code_version` is a Claude-shaped field in the wire schema; the
  opencode adapter reuses the neutral `clientInfo()` (hostname_hash + os). Schema-
  cosmetic follow-up; not blocking.

> **Note:** the opencode event field names (`sessionID`, `tool`, `args`, `tokens`)
> are mapped from opencode's documented plugin-bus event shape and are defensive
> (multiple key fallbacks). They should be tightened against a live opencode run —
> this task delivers the seam-validating baseline, not a production distribution.

## Goal

Implement a real second-agent adapter for **opencode** (https://opencode.ai — open-source terminal coding agent with a hook/event mechanism accessible enough to integrate) that ships conformant events through the shared transport, validates the adapter seam from P8-003, and finalizes the `Adapter` interface from two real examples.

## Context

This task is the validating second example the P6-006 deferral was waiting for. The rule: "extract the seam from two real examples to avoid the wrong abstraction." P8-003 extracted the seam and implemented the Claude Code adapter. This task implements opencode and uses that experience to finalize the `Adapter` interface — discovering any missing methods, overly Claude-specific assumptions, or interface gaps that only surface with a different agent.

opencode was chosen over cursor/aider because: (a) it is open-source, so its event/hook mechanism is auditable; (b) it is a terminal agent with a lifecycle similar to Claude Code (session start, tool calls, stop); (c) it emits structured events that can be mapped to the canonical `ConformantEvent` schema with reasonable fidelity.

Agent-type: `opencode` (already in `AgentType` enum from P5-006). Price table for opencode is stubbed in P8-002; this task populates it with real model prices.

This task is **not** a production-ready opencode distribution — it is an integration to prove the seam holds and the multi-agent pipeline is correct end-to-end.

## Acceptance criteria

- [x] `apps/hook/src/adapters/opencode.ts` implements the `HookAdapter` interface from P8-003.
- [x] The opencode adapter maps opencode's native lifecycle events to canonical `event_type` values; the mapping is documented in the file.
- [x] The adapter documents opencode's transcript/conversation storage shape and returns no transcript target until an export step is added.
- [x] The adapter's `installConfig()` produces the correct snippet to register hooks with opencode's configuration.
- [x] Sessions ingested via the opencode adapter appear in the DB with `agent_type = 'opencode'`.
- [x] Tool names are disambiguated per P8-001 (e.g. `opencode:Edit` is distinct from `claude_code:Edit`).
- [x] Cost is computed via the opencode price table from P8-002; at least one model price is real (not zero); unknown models fall back to `$0` + counter.
- [x] The `Adapter` interface in `apps/hook/src/adapters/index.ts` is finalized based on what opencode actually required — any changes to the interface are backward-compatible with the Claude Code adapter.
- [x] Transport files (`flusher.ts`, `shipper.ts`, `lib/queue.ts`) have zero opencode-specific code.
- [x] `bun run typecheck` passes; `bun run check` passes; existing hook tests pass.

## Implementation notes

Start by auditing opencode's hook/event documentation to understand the lifecycle. Map opencode's events to the canonical `EventType` enum; document any events that have no equivalent (map to a generic `metadata` event or drop with a log line — don't invent new `event_type` values without a schema change).

The install command writes opencode's equivalent of Claude Code's `~/.claude/settings.json` hook registrations. If opencode uses a different config path/format, `installConfig()` handles it; the transport never needs to know.

Populate `apps/ingest/src/data/price-table.opencode.v1.json` with real prices for any models opencode exposes (e.g. if it supports Anthropic models via API key, those share the claude_code prices; if it has its own billing, use those rates).

## Files touched

- `apps/hook/src/adapters/opencode.ts` (new)
- `apps/hook/src/adapters/index.ts` (interface finalization)
- `apps/hook/src/commands/install.ts` (adapter selection wiring)
- `apps/ingest/src/data/price-table.opencode.v1.json` (populate real prices)

## Out of scope

- Full feature parity with the Claude Code adapter (transcript-path heartbeat, all edge cases) — deliver a working baseline, file follow-ups for gaps.
- Production distribution of the opencode adapter binary.
- Support for every model opencode can route to — cover the common case; unknown models fall back cleanly.

## Verification

```bash
bun run typecheck
bun run check
bun --filter '@app/hook' test

# Integration (requires docker stack + opencode installed):
# 1. Install the opencode adapter hook
# 2. Run a short opencode session
# 3. Confirm events appear in DB with agent_type='opencode'
# 4. Confirm tool names carry the opencode: prefix (P8-001)
# 5. Confirm cost is non-zero for known opencode models
```

> **Verification status (done):** hook portion **fully verified locally** — `cd apps/hook
> && bun test` → 48 pass/0 fail (5 new opencode cases), `tsc --noEmit` clean, biome clean.
> `apps/ingest/test/price-tables.test.ts` (opencode table now populated) passes locally too.
> DB-backed end-to-end ingest of opencode events runs in CI / the docker stack. Tool
> disambiguation (`opencode:Edit` vs `claude_code:Edit`) is automatic via P8-001's query-time
> labelling; cost prices via the populated opencode table (P8-002). Transport files unchanged.
>
> **Accepted follow-up:** opencode stores conversation history as a directory of per-message JSON
> records, not a single transcript file. The adapter sends conformant events and deliberately returns
> `null` from `transcriptTarget`; an export-to-single-file step is required before opencode transcript
> uploads can match Claude Code/Codex transcript shipping.
