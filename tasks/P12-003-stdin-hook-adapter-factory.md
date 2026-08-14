---
id: P12-003
title: Stdin hook adapter factory (one implementation, N config objects)
phase: 12
workstream: D
status: done
owner: claude
depends_on: [P8-003, P12-002]
blocks: [P12-004, P12-005, P12-006]
estimate: M
---

## Goal

A `createStdinHookAdapter(config)` factory that turns "agent speaks Claude-shaped
stdin hook JSON" into a config object. Claude Code is its first caller, producing
byte-identical output to today; Codex, Gemini CLI, and Copilot become config objects
rather than files.

## Context

When P8-003 designed the seam, Claude Code's hook protocol was Claude's alone. It
isn't any more. Codex, Gemini CLI, and Copilot CLI all now hand a JSON payload to a
command on **stdin**, with the same base fields (`session_id`, `transcript_path`,
`cwd`, `hook_event_name`) and the same per-tool fields (`tool_name`, `tool_input`,
`tool_response`) — Codex uses our exact event names, Gemini uses its own
(`BeforeTool`), Copilot documents both camelCase natives and PascalCase aliases.

Building three more copies of `claude-code.ts` + `lib/payload.ts` would triple the
surface where an agent-specific bug can hide. The variation between these agents is
small and *declarative*: an event-name map, a set of field aliases, an install
snippet, and where the config file lives.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §3, with the field-by-field comparison table.

## Acceptance criteria

- [x] `createStdinHookAdapter(config)` returns a `HookAdapter`; config declares at
      minimum: `agentType`, the hook-kind → canonical `EventType` map, field aliases
      (e.g. `sessionId` ⇄ `session_id`, `toolArgs` ⇄ `tool_input`), which kinds are
      terminal for transcript shipping, and `installConfig`.
- [x] `claude-code.ts` is expressed through the factory and its existing tests pass
      **unchanged**.
- [x] A golden-output test proves the refactor is behavior-preserving: the same raw
      payload through old and new paths produces identical events modulo `event_id`
      and `ts`.
- [x] Field aliasing reads *both* spellings when an agent documents both, preferring
      the agent's native spelling and falling back to the alias.
- [x] An agent event with no canonical `EventType` is **dropped**, never mapped to an
      invented type — the rule opencode's adapter already documents.
- [x] Session IDs go through P12-002's normalization inside the factory, so no config
      object can forget it.
- [x] Emitted events pass `EventSchema.safeParse` (shared test helper from P12-002).
- [x] The `<10ms` hot path is unaffected: config lookup is a table read, not parsing.

## Implementation notes

`lib/payload.ts` holds Claude's mapping today, including notification-kind derivation
and the tool-category logic. The likely split is: generic assembly moves into the
factory; genuinely Claude-specific enrichment stays in `payload.ts` and is passed in
as an optional `enrich(kind, raw, event)` hook on the config.

Resist making the config Turing-complete. If an agent needs real logic (Pi, OMP,
opencode — all plugin-shaped, all needing their own file), it should *not* use the
factory. The factory is for agents that differ only in naming.

## Files touched

- `apps/hook/src/adapters/stdin-hook-factory.ts` (new) + test
- `apps/hook/src/adapters/claude-code.ts`, `apps/hook/src/lib/payload.ts`
- `apps/hook/src/lib/fields.ts` (new) — the payload-reading primitives the factory
  and the hand-rolled adapters now share, after the /simplify pass found four
  copies of the same loop disagreeing about empty strings
- `apps/hook/src/hook-entry.ts` — `eventsFor()` extracted so the "empty batch means
  handled" contract is testable without a second read of the process's stdin

## Out of scope

- Any new agent (that is P12-004/005/006).
- Changing the `HookAdapter` interface. The factory *produces* one; it does not widen
  the contract. If a new interface method seems necessary, stop — the seam's one
  extension since P8-003 (`mapBatch`) came from a real agent need, not a refactor.

## Verification

```bash
bun run --cwd apps/hook test
bun run --cwd apps/hook bench   # confirm the hot path did not regress
bun run check && bun run typecheck && bun run build && bun run test
```
