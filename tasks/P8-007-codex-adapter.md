---
id: P8-007
title: Codex CLI adapter (notify + rollout parsing)
phase: 8
workstream: D
status: review
owner: claude
depends_on: [P8-003, P8-004, P8-001, P8-002]
blocks: []
estimate: M
---

## Goal

Add a third `HookAdapter` for **OpenAI Codex CLI** so Codex sessions ingest,
render with the right labels (`agent_type = codex`), and never collide on tool
names — proving the seam (P8-003) extends to an agent with a fundamentally
different telemetry surface than Claude Code or opencode.

## Context

Codex's only stable extension point is its **`notify` program**: a command Codex
invokes once per turn (`agent-turn-complete`) with the notification JSON as the
first argument. That payload is turn-granular and thin — no per-tool events, no
token usage. The rich record (tool calls, token usage, the full conversation)
lives in the per-session **rollout JSONL** under `~/.codex/sessions/.../rollout-<ts>-<uuid>.jsonl`.

So a single `notify` invocation legitimately expands into MANY canonical events.
This is the first adapter to need the seam's multi-event path.

## Interface finding (extends P8-004's verdict)

The finalized `HookAdapter` held for opencode unchanged. Codex required **one
additive change**: an optional `mapBatch(kind, raw): ConformantEvent[] | null`.
When present and non-null, the transport enqueues every returned event and skips
`mapPayload`; returning null falls back to the single-event path. Adding it as
**optional** kept `claude-code` and `opencode` byte-for-byte identical (they emit
one event per hook and omit it). This is the seam working as designed — a third,
differently-shaped agent surfaced a real need, and the contract widened minimally
rather than per-agent branching leaking into the transport.

## Acceptance criteria

- [x] `codex` adapter selectable via `--agent codex`; unknown agents still fall
      back to `claude-code`.
- [x] `notify` turn-complete → a `Stop` event; tool calls in the turn → one
      `PostToolUse` each; token usage → an `llm` block on the Stop.
- [x] Tool calls + usage are read from the rollout JSONL, parsed defensively
      (tolerates the flat and `{ type, payload }` envelope shapes; skips
      unrecognized records).
- [x] A per-session byte **cursor** prevents re-emitting prior turns; `token_count`
      is treated as a running total and diffed to a per-turn delta (never summed).
- [x] The rollout file is shipped as the transcript (`transcriptTarget`).
- [x] A `codex` price table is registered — intentionally **empty** for now, so
      every Codex model bills `$0` via the table (not the unknown-agent fallback)
      until real OpenAI rates are filled in (P8-002 design).
- [x] `bun --cwd apps/hook test` + price-table tests pass; Biome + hook/schemas
      typecheck clean.

## Implementation notes

- `agent_type = codex` already existed across the stack (schemas `AgentType`,
  the DB enum, and `agent-display.ts`), so **no schema migration** was needed —
  exactly the "accept a new agent without migration" promise of DESIGN_DOC §2.2.
- The rollout parser (`apps/hook/src/lib/codex-rollout.ts`) is a **pure** core
  (records → tool descriptors + cumulative usage) so the version-sensitive Codex
  format is unit-testable; all file I/O + cursor state live in the adapter.
- `notify` has no session-end signal, so the (growing) rollout is re-shipped each
  turn under the same session id; ingest keeps the latest, converging on the full
  conversation. The per-tool events carry the structured counts.

## Files touched

- `apps/hook/src/adapters/codex.ts` (new; adapter + rollout location + cursor I/O)
- `apps/hook/src/lib/codex-rollout.ts` (new; pure rollout parser + `usageDelta`)
- `apps/hook/src/adapters/index.ts` (register `codex`; add optional `mapBatch`)
- `apps/hook/src/hook-entry.ts` (use `mapBatch` when present; enqueue N events)
- `apps/ingest/src/data/price-table.codex.v1.json` (new; empty placeholder)
- `apps/ingest/src/lib/price-tables.ts` (register the codex table)
- `apps/hook/test/codex-rollout.test.ts`, `apps/hook/test/codex-adapter.test.ts`,
  `apps/ingest/test/price-tables.test.ts` (codex case)

## Out of scope

- Real OpenAI per-model prices (the table is a deliberate empty placeholder).
- A session-end signal / smarter transcript de-duplication (re-ship per turn is fine).
- Parsing the rollout into a normalized transcript view (ships raw; redaction runs
  ingest-side as for any transcript).

## Verification

```bash
bun --cwd apps/hook test
bun --cwd apps/ingest test price-tables
bunx tsc -p apps/hook/tsconfig.json --noEmit
bun run check
```

> **Verification status (review):** 66 hook tests pass (rollout parser + adapter,
> incl. a temp-`CODEX_HOME` integration test exercising mapBatch + cursor advance);
> 5 price-table tests pass; hook + schemas typecheck clean; Biome clean. CI is the
> gate for the Prisma-dependent ingest typecheck/tests.
