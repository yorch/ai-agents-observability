---
id: P12-005
title: Gemini CLI adapter
phase: 12
workstream: D
status: ready
owner: null
depends_on: [P12-001, P12-003]
blocks: []
estimate: M
---

## Goal

Gemini CLI sessions ingest through the stdin-hook factory: session lifecycle, per-tool
events with MCP attribution, and token usage, rendering as `Gemini CLI` with tool names
disambiguated per P8-001.

## Context

Gemini CLI's hooks are configured in `settings.json` under a `hooks` object keyed by
event, each entry `{ matcher?, sequential?, hooks: [{ type: "command", command,
timeout? }] }`. The stdin payload is Claude-shaped — `session_id`, `transcript_path`,
`cwd`, `hook_event_name`, `timestamp` — so the only real work is the event-name map:

| Gemini | canonical |
|---|---|
| `SessionStart` / `SessionEnd` | `SessionStart` / `SessionEnd` |
| `BeforeTool` / `AfterTool` | `PreToolUse` / `PostToolUse` |
| `BeforeAgent` / `AfterAgent` | `UserPromptSubmit` / `Stop` |
| `PreCompress` | `PreCompact` |
| `Notification` | `Notification` |
| `BeforeModel` / `AfterModel` / `BeforeToolSelection` | *(drop — no equivalent)* |

Gemini is the first agent to hand us **MCP context** at the tool boundary
(`mcp_context`, `original_request_name`), which fills `tool.mcp_server` /
`tool.mcp_tool` — fields opencode and codex both leave null.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §2.2.

## Acceptance criteria

- [ ] `--agent gemini-cli` selects the adapter; unknown agents still fall back to
      claude-code.
- [ ] The event map above holds; `BeforeModel`/`AfterModel`/`BeforeToolSelection` are
      dropped rather than mapped to an invented type.
- [ ] `tool_response` (`llmContent` / `returnDisplay` / `error`) populates
      `output_bytes` and `exit_status`.
- [ ] An MCP tool call sets `tool.category = 'mcp'` with `mcp_server` and `mcp_tool`
      populated from `mcp_context`.
- [ ] Token usage lands in an `llm` block, priced against `price-table.gemini_cli.v1.json`.
      Read from `AfterModel`'s `llm_response` if reliable; otherwise from the session
      transcript at `transcript_path` — document which, and why, in the adapter header.
- [ ] `transcriptTarget()` returns the `transcript_path` at the terminal event, so
      Gemini transcripts upload.
- [ ] `install --agent gemini-cli` prints the `settings.json` snippet with the right
      hook object shape (including `timeout`).

## Implementation notes

Gemini CLI also exports OTLP with token metrics. That is **not** the path here (see
research §4) — it bypasses redaction, the local queue, and the correlation spine — but
it is a useful cross-check when validating that our per-session token totals are right.

Extension-bundled hooks (`hooks/hooks.json` inside a Gemini extension) would let us
distribute the wiring as an installable extension rather than a settings edit. Treat
that as a follow-up; verify it against shipped docs first, as our source for it is a
blog post and an in-flight PR.

## Files touched

- `apps/hook/src/adapters/gemini-cli.ts` (+ test), `apps/hook/src/adapters/index.ts`
- `apps/hook/src/commands/install.ts`

## Out of scope

- OTLP ingestion of any kind.
- Real Gemini price data (empty table from P12-001 is correct for now).

## Verification

```bash
bun run --cwd apps/hook test
bun run check && bun run typecheck && bun run build && bun run test
```
