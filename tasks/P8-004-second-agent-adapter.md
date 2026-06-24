---
id: P8-004
title: Second-agent adapter (opencode)
phase: 8
workstream: D
status: blocked
owner: null
depends_on: [P8-003, P8-001, P8-002]
blocks: []
estimate: L
---

## Goal

Implement a real second-agent adapter for **opencode** (https://opencode.ai — open-source terminal coding agent with a hook/event mechanism accessible enough to integrate) that ships conformant events through the shared transport, validates the adapter seam from P8-003, and finalizes the `Adapter` interface from two real examples.

## Context

This task is the validating second example the P6-006 deferral was waiting for. The rule: "extract the seam from two real examples to avoid the wrong abstraction." P8-003 extracted the seam and implemented the Claude Code adapter. This task implements opencode and uses that experience to finalize the `Adapter` interface — discovering any missing methods, overly Claude-specific assumptions, or interface gaps that only surface with a different agent.

opencode was chosen over cursor/aider because: (a) it is open-source, so its event/hook mechanism is auditable; (b) it is a terminal agent with a lifecycle similar to Claude Code (session start, tool calls, stop); (c) it emits structured events that can be mapped to the canonical `ConformantEvent` schema with reasonable fidelity.

Agent-type: `opencode` (already in `AgentType` enum from P5-006). Price table for opencode is stubbed in P8-002; this task populates it with real model prices.

This task is **not** a production-ready opencode distribution — it is an integration to prove the seam holds and the multi-agent pipeline is correct end-to-end.

## Acceptance criteria

- [ ] `apps/hook/src/adapters/opencode.ts` implements the `HookAdapter` interface from P8-003.
- [ ] The opencode adapter maps opencode's native lifecycle events to canonical `event_type` values; the mapping is documented in the file.
- [ ] The adapter resolves opencode's transcript/conversation file path correctly (equivalent of the `~/.claude/...` path for Claude Code).
- [ ] The adapter's `installConfig()` produces the correct snippet to register hooks with opencode's configuration.
- [ ] Sessions ingested via the opencode adapter appear in the DB with `agent_type = 'opencode'`.
- [ ] Tool names are disambiguated per P8-001 (e.g. `opencode:Edit` is distinct from `claude_code:Edit`).
- [ ] Cost is computed via the opencode price table from P8-002; at least one model price is real (not zero); unknown models fall back to `$0` + counter.
- [ ] The `Adapter` interface in `apps/hook/src/adapters/index.ts` is finalized based on what opencode actually required — any changes to the interface are backward-compatible with the Claude Code adapter.
- [ ] Transport files (`flusher.ts`, `shipper.ts`, `lib/queue.ts`) have zero opencode-specific code.
- [ ] `bun run typecheck` passes; `bun run check` passes; existing hook tests pass.

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
