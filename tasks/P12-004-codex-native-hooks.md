---
id: P12-004
title: Codex native lifecycle hooks (retire most of the rollout machinery)
phase: 12
workstream: D
status: done
owner: claude
depends_on: [P8-007, P12-003]
blocks: []
estimate: M
---

## Goal

Codex sessions capture per-tool events directly from Codex's lifecycle hooks instead
of being inferred from the rollout file, with `notify` retained as a fallback for
users who have not enabled the (currently experimental) hook system.

## Context

P8-007 shipped the Codex adapter against a hard constraint: `notify` was the only
stable extension point — one invocation per turn, no per-tool data, no tokens. So the
adapter tails `~/.codex/sessions/**/rollout-*.jsonl` behind a per-session byte cursor
and expands one notify into N events via `mapBatch` (the seam's only interface
extension to date).

Codex now has real hooks: `SessionStart`, `SessionEnd`, `SubagentStart`,
`SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
`PostCompact`, `UserPromptSubmit`, `Stop` — **our event names**, Claude-shaped stdin
payload (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
`permission_mode`, plus a Codex-specific `turn_id`), config in `hooks.json` or inline
`[hooks]` in `config.toml`.

Two caveats that shape the design:

- The system is **experimental**: gated behind `[features] hooks = true` (the
  `codex_hooks` key is a deprecated alias) and **not available on Windows**. It cannot
  be the only path.
- The hook payload carries `model` but **not token usage**. The rollout read stays —
  narrowed to usage on `Stop`.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §2.1.

## Acceptance criteria

- [x] Codex `PreToolUse`/`PostToolUse` hooks produce one canonical event each, with
      `tool_name`/`tool_input`/`tool_response` populating the `tool` block — no
      rollout inference involved.
- [x] `transcript_path` from the hook payload feeds `transcriptTarget()`, replacing
      the directory scan for the rollout file.
- [x] `Stop` still carries an `llm` block: usage is read from the rollout, with the
      existing running-total → per-turn **delta** treatment preserved (never summed).
- [x] The `notify` path still works end-to-end when hooks are off, including its
      `mapBatch` expansion. Both paths active simultaneously must not double-count a
      turn.
- [x] `install --agent codex` detects which path is available and prints the matching
      snippet (`hooks.json` when the feature flag is on, `notify` otherwise), naming
      the flag explicitly.
- [x] `turn_id` is preserved in `metadata` rather than discarded — it is the only
      turn-scoped correlator Codex gives us.
- [x] Windows users, and users on a Codex older than the hook release, are unaffected.

## Implementation notes

The dedupe question is the one with teeth: with both paths wired, a turn produces a
`Stop` from `notify` *and* a `Stop` from the hook. Prefer the hook and suppress the
`notify` expansion when a hook-sourced event for that `(session_id, turn_id)` has been
seen — the byte cursor already gives a per-session state file to record that in.

Codex merges `hooks.json` with inline `[hooks]` when both exist in one layer, warning
at startup. `install` should write only one of them.

## Files touched

- `apps/hook/src/adapters/codex.ts` (+ test), `apps/hook/src/lib/codex-rollout.ts`
- `apps/hook/src/commands/install.ts`

## Out of scope

- Real OpenAI price data in `price-table.codex.v1.json` (still deferred from P8-002).
- Removing `mapBatch` from the seam — opencode and future agents may still need it,
  and it is optional by design.

## Verification

```bash
bun run --cwd apps/hook test
bun run check && bun run typecheck && bun run build && bun run test
```
