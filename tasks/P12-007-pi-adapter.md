---
id: P12-007
title: Pi adapter (TS extension + single-file JSONL transcripts)
phase: 12
workstream: D
status: done
owner: claude
depends_on: [P12-001, P12-002]
blocks: []
estimate: M
---

## Goal

Pi sessions ingest end-to-end — lifecycle, tools, usage, **and transcripts** — via a
Pi extension that shells out to the hook binary, the same pattern opencode uses.

## Context

Pi (`@earendil-works/pi-coding-agent`) has no stdin command hooks; it has TypeScript
**extensions**: a module exporting `export default function (pi: ExtensionAPI) { … }`,
auto-loaded from `~/.pi/agent/extensions/*.ts` or `.pi/extensions/*.ts`, subscribing
via `pi.on(eventName, handler)`. So this is a plugin-shaped adapter (like opencode),
not a factory config (P12-003).

Event map:

| Pi | canonical |
|---|---|
| `session_start` | `SessionStart` |
| `input` (or `before_agent_start`) | `UserPromptSubmit` |
| `tool_call` | `PreToolUse` |
| `tool_result` | `PostToolUse` |
| `turn_end` | `Stop` |
| `session_before_compact` | `PreCompact` |
| `session_shutdown` | `SessionEnd` |

**Pi is the best-shaped agent surveyed**, and the reason this task is worth doing
before OMP:

- Sessions are **one JSONL file** —
  `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl` — so `transcriptTarget()`
  works on day one. opencode's directory-shaped storage has blocked transcript upload
  since P8-004; Pi has no such gap.
- **Session IDs are UUIDs** natively — the first non-Claude agent for which P12-002's
  normalization is a pass-through.
- Per-assistant-message `usage` carries input, output, cache read/write **and a cost
  breakdown**.

One structural caveat: Pi sessions are **trees**, not lists. Entries carry `id` and
`parentId`, and branching happens in place, so a file can contain abandoned branches.
The shipper ships bytes and is unaffected; anything that *counts* from the transcript
must respect `parentId`.

Research: [`docs/research/2026-08-13-agent-adapter-expansion.md`](../docs/research/2026-08-13-agent-adapter-expansion.md) §2.4.

## Acceptance criteria

- [x] `--agent pi` selects the adapter; the event map above holds; Pi events with no
      canonical equivalent (`context`, `model_select`, `before_provider_request`,
      `message_*`, `tool_execution_*`, …) are dropped, not invented.
- [x] `tool_call`/`tool_result` produce `PreToolUse`/`PostToolUse` with a populated
      `tool` block (name, input/output bytes, denial when the call was blocked).
- [x] `turn_end` carries an `llm` block with model + token usage, priced against
      `price-table.pi.v1.json`.
- [x] `transcriptTarget()` returns the session's `.jsonl` path at the terminal event.
- [ ] **Unverified:** a real transcript uploads, checked against a *recorded* Pi
      session rather than a hand-written fixture. Pi is not installed in the dev
      container, so the tests use fixtures built from the documented session
      format. The field names the extension forwards (`ctx.sessionManager.path`,
      the `usage` nesting) are inferred from docs and should be confirmed against
      a real session before this is called done-done.
- [x] The Pi session UUID passes through P12-002 unchanged (assert this explicitly —
      it is the one adapter where a derivation would be *wrong*).
- [x] `install --agent pi` emits an extension module to
      `~/.pi/agent/extensions/telemetry.ts` (or prints it), spawning
      `<bin> hook <kind> --agent pi` with the event JSON on stdin.
- [x] The extension never blocks or mutates Pi's behavior: `tool_call` can block and
      `tool_result` can modify results in Pi's API — our handler must return nothing
      and swallow its own errors.

## Implementation notes

Pi's agent-completion semantics have two candidates: `turn_end` fires per turn (one
LLM response + tool calls), while `agent_settled` fires once the agent is genuinely
done (after auto-retry / auto-compaction / queued follow-ups). Map `turn_end` → `Stop`
for per-turn cost attribution, and consider `agent_settled` only if session-level
"done" turns out to matter for effectiveness signals. Document the choice.

Do **not** reach for `@earendil-works/pi-telemetry`. It is an OpenTelemetry-style span
contract for instrumenting Pi's internals, not a lifecycle event stream — wrong seam.

## Files touched

- `apps/hook/src/adapters/pi.ts` (+ test), `apps/hook/src/adapters/index.ts`
- `apps/hook/src/commands/install.ts`
- possibly `apps/hook/src/lib/transcript-parser.ts` (tree-aware traversal)

## Out of scope

- Rendering Pi's session branches in the web transcript viewer — capture first,
  presentation later.
- Ingesting Pi's self-reported cost instead of computing it from the price table.
  Agent-reported cost crosses P8-006's reconciliation design; decide it there.

## Verification

```bash
bun run --cwd apps/hook test
bun run check && bun run typecheck && bun run build && bun run test
```
