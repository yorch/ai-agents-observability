---
id: P12-006
title: GitHub Copilot CLI adapter
phase: 12
workstream: D
status: done
owner: claude
depends_on: [P12-002, P12-003]
blocks: []
estimate: M
---

## Goal

GitHub Copilot CLI sessions ingest through the stdin-hook factory, reading Copilot's
camelCase payload fields and its PascalCase aliases interchangeably.

## Context

Copilot CLI's hooks are the most configuration-heavy of the four stdin agents:
a versioned document — `{ version: 1, disableAllHooks, hooks: { event: [{ type:
"command" | "http" | "prompt", matcher? }] } }` — discovered from a layered set of
locations (`~/.copilot/hooks/`, `.github/hooks/*.json`, `~/.copilot/settings.json`,
policy directories, plugins). Command hooks accept `bash` / `powershell` / a
cross-platform `command`, plus `cwd`, `env`, and `timeoutSec` (default 30s).

Events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `userPromptTransformed`,
`preToolUse`, `postToolUse`, `postToolUseFailure`, `preCompact`, `permissionRequest`,
`agentStop`, `subagentStart`, `subagentStop`, `errorOccurred`, `notification` — each
with a documented PascalCase alias (`PreToolUse`, `SessionStart`, `Stop`, …).

Two Copilot-specific quirks:

- Base payload fields are **camelCase** (`sessionId`, `timestamp`, `cwd`,
  `toolName`, `toolArgs`, `toolResult`), and the PascalCase alias form reportedly
  carries an ISO-8601 `timestamp` where the camelCase form carries a number. Read both
  spellings and both timestamp encodings rather than picking one.
- `preToolUse` command hooks are **fail-closed**: a crash or non-zero exit denies the
  tool call. Our hook binary already guarantees exit 0 unconditionally
  (`hook-entry.ts`), which is exactly the invariant this agent punishes you for
  breaking — restate it in the adapter header so nobody "improves" it later.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §2.3.

## Acceptance criteria

- [x] `--agent copilot` selects the adapter; events map: `sessionStart`→`SessionStart`,
      `sessionEnd`→`SessionEnd`, `userPromptSubmitted`→`UserPromptSubmit`,
      `preToolUse`→`PreToolUse`, `postToolUse`→`PostToolUse`, `agentStop`→`Stop`,
      `preCompact`→`PreCompact`, `subagentStop`→`SubagentStop`,
      `notification`→`Notification`.
- [x] `postToolUseFailure` maps to `PostToolUse` with a non-zero `tool.exit_status` —
      not to a new event type.
- [x] `errorOccurred`, `userPromptTransformed`, `permissionRequest`, and
      `subagentStart` are dropped (no canonical equivalent), and dropping is
      *silent-but-logged*, never a throw.
- [x] Both field spellings parse: a camelCase payload and its PascalCase equivalent
      produce the same event modulo `event_id`/`ts`.
- [x] Numeric and ISO-8601 `timestamp` values both produce a valid ISO `ts`.
- [x] Session IDs go through P12-002 normalization (Copilot's `sessionId` format is
      unspecified and must not be assumed to be a UUID).
- [x] `install --agent copilot` writes/prints a `~/.copilot/hooks/` document with
      `version: 1`, using the cross-platform `command` form and an explicit
      `timeoutSec`.
- [x] A test asserts the emitted event validates against `EventSchema`.

## Implementation notes

Copilot has no `transcript_path` in its documented payload, so `transcriptTarget()`
returns null for now — the opencode precedent. If a session log location turns out to
be discoverable, that is a follow-up, not a blocker.

Copilot's `http` and `prompt` hook types are out of scope; we install a `command` hook
like every other agent.

## Files touched

- `apps/hook/src/adapters/copilot.ts` (+ test), `apps/hook/src/adapters/index.ts`
- `apps/hook/src/commands/install.ts`

## Out of scope

- Copilot's own OpenTelemetry integration.
- Copilot Cloud Agent (`.github/hooks/*.json` in a cloned repo) — a different install
  story from a developer machine; revisit once the CLI path is proven.

## Verification

```bash
bun run --cwd apps/hook test
bun run check && bun run typecheck && bun run build && bun run test
```
