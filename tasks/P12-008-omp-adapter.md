---
id: P12-008
title: OMP (oh-my-pi) adapter
phase: 12
workstream: D
status: done
owner: claude
depends_on: [P12-001, P12-002, P12-007]
blocks: []
estimate: M
---

## Goal

OMP sessions ingest end-to-end via an OMP hook module that shells out to the hook
binary, including single-file JSONL transcript upload.

## Context

OMP is a fork of Pi that added subagents, plan mode, LSP/DAP, and a Rust core. Like
Pi, its native hooks are **ES modules receiving a `HookAPI` object** — not stdin JSON —
so this is a plugin-shaped adapter, and it should follow P12-007's structure closely.

Events: `session_start`, `session_before_compact`, `session_compact`,
`session_shutdown`, `before_agent_start`, `agent_start`, `agent_end`, `turn_start`,
`turn_end`, `auto_compaction_start`/`_end`, `context`, `tool_call`, `tool_result`,
and others.

Storage:
`~/.omp/agent/sessions/<scope>-<project>-<sha256(cwd)>/<timestamp>_<sessionId>.jsonl`
— single file per session, `usage` (tokens, cache read/write, cost breakdown) on each
message entry, blobs externalized to `~/.omp/agent/blobs/<sha256>`.

Three OMP-specific traps:

- **Session IDs are 16-char hex**, not UUIDs → P12-002 normalization is mandatory.
- Session files begin with a **fixed 256-byte title slot** before the header line. A
  naive JSONL reader will choke on the first "line".
- The config root is **unresolved**: the repo docs say `~/.omp/`, while `omp.sh/docs`
  and third-party writeups say `~/.oh-omp/`. `omp.sh/docs` blocks our fetcher, so this
  was not settled during research.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §2.5.

## Acceptance criteria

- [x] `--agent omp` selects the adapter; map `session_start`→`SessionStart`,
      `before_agent_start`→`UserPromptSubmit`, `tool_call`→`PreToolUse`,
      `tool_result`→`PostToolUse`, `turn_end`→`Stop`,
      `session_before_compact`→`PreCompact`, `session_shutdown`→`SessionEnd`; drop the
      rest.
- [x] A 16-hex OMP session ID produces a stable, valid UUID `session_id`, identical
      across every event in that session, and distinct from the same string under
      another agent type.
- [x] `turn_end` carries an `llm` block with model + usage, priced against
      `price-table.omp.v1.json`.
- [x] `transcriptTarget()` resolves the session `.jsonl`, and both readers skip the
      256-byte title slot — `safeJsonObject` in the hook and `parseTranscriptLine`
      in ingest's transcript indexer — covered by fixtures that include it.
- [x] `install --agent omp` probes **both** `~/.omp/agent/` and `~/.oh-omp/agent/`,
      preferring whichever holds a `sessions/` directory, and the snippet names both.
- [ ] **Unresolved:** which root is actually correct. omp is not installed in the
      dev container and `omp.sh/docs` blocks our fetcher, so both remain
      candidates (`OMP_HOME` overrides). Collapse this to the true one — and
      record which it was in the adapter header — once someone can check a real
      installation.
- [x] The hook module never blocks a tool call or injects context — `omp.sendMessage`
      and blocking returns are not used.

## Implementation notes

The alternative route is [`omp-hooks`](https://github.com/ZeR020/omp-hooks), a
community plugin that makes OMP execute Claude Code-style `settings.json` command-hook
arrays — which would let OMP ride the P12-003 factory with an event map and no adapter
code at all. **Ship the native module anyway**: making our install path depend on a
third-party package we do not control is a worse trade than one small file. Document
`omp-hooks` in the hook README as a supported alternative for users who already run it.

Subagents are first-class in OMP. `SubagentStop` exists canonically; if OMP's events
distinguish subagent turns, populate `tool.subagent_type` rather than flattening them
into the parent session.

## Files touched

- `apps/hook/src/adapters/omp.ts` (+ test), `apps/hook/src/adapters/index.ts`
- `apps/hook/src/commands/install.ts`, `apps/hook/src/lib/transcript-parser.ts`
- `apps/hook/README.md` (the `omp-hooks` alternative)

## Out of scope

- Resolving OMP blobs (`~/.omp/agent/blobs/`) during transcript upload — externalized
  images are not conversation content we need.
- LSP/DAP-specific telemetry.

## Verification

```bash
bun run --cwd apps/hook test
bun run check && bun run typecheck && bun run build && bun run test
```
