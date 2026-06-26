---
id: P8-003
title: Hook adapter seam
phase: 8
workstream: D
status: done
owner: claude
depends_on: [P5-006]
blocks: [P8-004]
estimate: L
---

## Decision (provisional interface)

`HookAdapter` (`apps/hook/src/adapters/index.ts`) is: `agentType`, `isHookKind`,
`mapPayload(kind, raw)`, `transcriptTarget(kind, raw)`, `installConfig()`.

Two honest deviations from the sketch, both because the spec's premise about
`paths.ts` was inaccurate:
- **`transcriptTarget(kind, raw)` instead of `transcriptPath(sessionId, cwd)`.**
  Claude Code does not compute a transcript path — it *sends* `transcript_path` in
  the Stop payload. `paths.ts` is the telemetry tool's own state dir
  (`~/.claude-telemetry/`), which is agent-neutral and stays put. So the real seam
  is "given a terminal payload, where's the transcript" — returned from the payload.
- **`flusher.ts` / `shipper.ts` were left untouched** — they already import only the
  neutral `paths.ts` (telemetry home) and never `payload.ts`; the transcript path
  rides in the ship marker the adapter produces. The transport was already
  agent-agnostic; nothing to re-route.

Interface remains **provisional** until P8-004 validates it against opencode.

## Goal

Extract an `Adapter` interface in `apps/hook` so the agent-neutral transport (queue, flusher, shipper, retry/abandon, transcript machinery) is reused across agents while the Claude-specific bits live behind the contract. The Claude Code adapter becomes the first implementation with no behavior change. This is the deferred **P6-006**.

## Context

The transport layer in `apps/hook` is already agent-neutral: `apps/hook/src/flusher.ts`, `apps/hook/src/shipper.ts`, `apps/hook/src/lib/queue.ts`, and the retry/abandon logic do not branch on agent type. The Claude-specific surface is:

- `apps/hook/src/lib/payload.ts` — `HOOK_KIND_TO_EVENT_TYPE` maps Claude Code hook kinds (e.g. `PreToolUse`, `PostToolUse`, `Stop`) to the canonical `event_type` enum; builds the structured payload from Claude's stdin JSON.
- `apps/hook/src/lib/paths.ts` — resolves `~/.claude/projects/<encoded>/<session_id>.jsonl` for transcript reads.
- `apps/hook/src/commands/install.ts` / `apps/hook/src/commands/uninstall.ts` — write Claude Code hook configuration into `~/.claude/settings.json`.

DESIGN_DOC.md §6.3 describes the hook payload contract as agent-agnostic; each adapter translates from its agent's native event format into that contract.

Per P6-006's deferral note: "extract the seam *from two real examples* to avoid the wrong abstraction." This task extracts the seam and implements the Claude Code adapter. P8-004 implements the second adapter and finalizes the interface. **The interface defined here is provisional until P8-004 signs off on it.**

## Acceptance criteria

- [x] `apps/hook/src/adapters/` directory exists with a documented `Adapter` TypeScript interface (or abstract class) covering: (a) event mapping (`mapHookPayload(raw: unknown): ConformantEvent`), (b) transcript path resolution (`transcriptPath(sessionId: string): string`), (c) install metadata (`installSnippet(): InstallConfig`).
- [x] `apps/hook/src/adapters/claude-code.ts` implements the interface with identical behavior to the current `payload.ts` + `paths.ts` + `commands/install.ts` logic (no behavior change).
- [x] All existing hook tests pass without modification.
- [x] `apps/hook/src/hook-entry.ts`, `apps/hook/src/flusher.ts`, and `apps/hook/src/shipper.ts` reference the adapter through the interface, not through direct imports of `payload.ts` or `paths.ts`.
- [x] Adding a second adapter requires implementing only the `Adapter` interface — no edits to transport files (`flusher.ts`, `shipper.ts`, `lib/queue.ts`).
- [x] `bun run typecheck` passes; `bun run check` passes.

## Implementation notes

A minimal interface might be:

```typescript
export interface HookAdapter {
  /** Translate a raw hook stdin payload into a ConformantEvent (or null to drop). */
  mapPayload(raw: unknown): ConformantEvent | null;
  /** Absolute path to the agent's transcript file for the given session. */
  transcriptPath(sessionId: string, cwd: string): string;
  /** Config to write during `install` — hook command lines, config file path, etc. */
  installConfig(): AdapterInstallConfig;
}
```

Keep it narrow. Resist adding hooks for lifecycle events the second adapter might not have — wait for P8-004 to surface real needs before widening the interface.

The CLI entry point (`apps/hook/src/cli.ts`) selects the adapter based on a `--agent` flag (defaulting to `claude-code`) or an env var; the default must be `claude-code` so no existing install is disrupted.

## Files touched

- `apps/hook/src/adapters/` (new directory)
- `apps/hook/src/adapters/index.ts` (interface + types)
- `apps/hook/src/adapters/claude-code.ts` (Claude Code implementation)
- `apps/hook/src/lib/payload.ts` (refactored into adapter; file may be retained as a thin re-export for backward compat)
- `apps/hook/src/lib/paths.ts` (absorbed into adapter)
- `apps/hook/src/hook-entry.ts`
- `apps/hook/src/flusher.ts`
- `apps/hook/src/shipper.ts`
- `apps/hook/src/commands/install.ts`
- `apps/hook/src/commands/uninstall.ts`

## Out of scope

- The second adapter implementation — that is P8-004.
- Changing the hook's wire protocol or payload schema.
- Any change to `apps/ingest` — ingest is already adapter-agnostic.
- Finalizing the `Adapter` interface — it is provisional until P8-004 validates it against a real second agent.

## Verification

```bash
bun run typecheck
bun run check
bun --filter '@app/hook' test

# Smoke: install still writes correct claude settings
bun run --cwd apps/hook dev -- install --dry-run
```

> **Verification status (done): fully verified locally** (the hook has no Prisma
> dependency, so the egress block doesn't apply here). `cd apps/hook && bun test` →
> **43 pass / 0 fail, no test files modified** (acceptance #3); `tsc --noEmit` → clean;
> `biome check --error-on-warnings` → clean. Claude Code adapter delegates to the
> existing `payload.ts` (`toEvent`/`isHookKind`) so behavior is byte-for-byte identical.
> `hook-entry.ts`, `cli.ts`, and `install.ts` go through the adapter; transport files
> (`flusher`/`shipper`/`queue`) untouched. `--agent` selects the adapter (default
> `claude-code`).
