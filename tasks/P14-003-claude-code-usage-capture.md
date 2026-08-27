---
id: P14-003
title: Claude Code per-turn usage capture + turn linkage
phase: 14
workstream: A
status: review
owner: claude
depends_on: [P14-002]
blocks: [P14-004]
estimate: M
---

## Goal

Claude Code records real token usage in steady state, per assistant turn, without
anyone running `claude-telemetry import` — and the turns are linked, so a tool
call can be attributed to the turn that issued it.

## Context

**Claude Code recorded `$0` in steady state, across the entire product.** The
evidence chain, all read off the code before this task started:

1. `apps/hook/src/lib/payload.ts` maps no usage or token fields — Claude Code's
   hook payload does not carry them, on any hook, Stop included.
2. `apps/ingest/src/lib/insert-events.ts` computes `cost_usd` **only** when an
   event carries an `llm` block. No `llm` → NULL cost.
3. `apps/ingest/src/lib/upsert-session.ts` accumulates `sessions.total_cost_usd`
   from exactly those events. No `llm` → `$0` sessions.
4. The only producer of an `llm` block for `CLAUDE_CODE` was `entryToEvents` in
   `apps/hook/src/lib/import-synth.ts`, called from one place:
   `apps/hook/src/commands/import.ts` — the `import` subcommand, which backfills
   **historical** sessions.
5. The transcript *is* shipped in steady state
   (`apps/hook/src/adapters/claude-code.ts`, `transcriptKinds: ['stop']`) and
   contains the usage, but `apps/ingest/src/routes/transcripts.ts` archives it to
   S3 and reads nothing out of it.

That zero propagated to the org dashboard, weekly spend, run-rate projection,
`/me/insights` "Total cost", PR-rollup cost, and the whole of Phase 10's routing
optimization.

The other adapters had already solved it. `DESIGN_DOC.md` §6.2: the optional
`mapBatch` seam "lets one hook fire expand into multiple events (used by the Codex
adapter to read rollout JSONL, and by Gemini to fold per-call token usage onto the
turn's Stop)". Claude Code has the identical side channel — the Stop payload hands
you `transcript_path` — and was the one adapter that never wired it up.

Per `DESIGN_DOC.md` §6.7 the adapter emits `cost_usd: 0` and ingest recomputes
from the versioned per-agent price table, so this task emits token counts and a
model, never money.

## What was built

### Per-turn usage on the live path

`claudeCodeAdapter.mapBatch('stop', …)` reads the transcript entries appended
since the last Stop and emits **one Stop event per assistant turn**, each carrying
that turn's `llm` block.

One Stop per *turn*, not per hook fire, because Claude Code's Stop hook fires once
per user-prompt response cycle, which can span many assistant turns; summing them
into one event would discard exactly the granularity this exists to produce.

### The id/ts agreement, and why it is the double-counting fix

The Stop event's `event_id` and `ts` come from the transcript entry itself, via
the new shared `apps/hook/src/lib/claude-turns.ts`, so they are **identical to
what `import` synthesizes for the same turn**.

This matters because the live path and the `import` path can both produce events
for the same session, and nothing stops them: `runImport` walks every file under
`~/.claude/projects` with no filter for sessions already captured live, and
`README.md` recommends `import` for backfill. Before this task that was a latent
event-count duplication; once the live path carries usage it would have become
**cost** double-counting, and `sessions.total_cost_usd` accumulates
(`total_cost_usd = sessions.total_cost_usd + EXCLUDED.total_cost_usd`) and is
never recomputed, so it could not drift back into agreement on its own.

With the ids and timestamps matching, ingest's
`ON CONFLICT (event_id, ts) DO NOTHING` makes the second path a no-op — and
`apps/ingest/src/routes/events.ts` feeds only newly-inserted events into the
session accumulator, so the totals stay right too. `turn-linkage.test.ts` pins the
agreement.

### Incremental read

`redactedLines()` streams the whole file, and Stop fires once per cycle, so
re-reading the transcript at every Stop is O(n²) over a session. The read is
incremental instead: a per-session `{ path, offset, turns }` cursor under
`agentStateDir('claude-code')` — beside codex's rollout cursors and gemini's
token accumulators, per `apps/hook/AGENTS.md`, so `purge-local` clears it without
naming the agent. The SQLite queue was considered and rejected: it is the
transport's, opened by `hook-entry` purely to append rows, and putting adapter
state there would place it outside the one directory `purge` knows about.

The **first** Stop of a session reads from the top of the file on purpose — the
turn ordinal has to be counted from entry one to agree with what `import`
computes, and to continue a `--resume`d file's numbering.

Claude Code registers no SessionEnd hook, so there is no moment to drop a
session's cursor deliberately; stale cursors are swept (14 days) on the first Stop
of a new session, which is one `readdir` per session and never on the tool path.

### Turn linkage

- `turn_number` (INT): 1-based, monotonically increasing within a `session_id`,
  one increment per assistant turn.
- `parent_event_id` (UUID): on a tool event, the `event_id` of the Stop for the
  turn that issued it. NULL on the Stop itself and on non-tool events.

`import --since` now counts the turns it skips, so a windowed import numbers turns
exactly as a full import of the same session does.

## The part of the contract that could NOT be honoured

**Live `PreToolUse` / `PostToolUse` events carry NULL `turn_number` and NULL
`parent_event_id`.** This was reported rather than approximated, and agreed with
the P14-004 owner before implementation.

Two independent reasons:

1. **Ordering.** Each hook is its own short-lived process, and the tool hooks fire
   *before* the Stop of the turn that issued them. The Stop's `event_id` does not
   exist yet — and even with deterministic ids, the seed is the assistant entry's
   uuid, which a tool hook has no way to know without reading and parsing the
   transcript on the hottest path in the binary (PreToolUse fires far more often
   than Stop), racing across parallel tool calls.
2. **Cadence.** Claude Code's Stop hook fires once per user-prompt response cycle,
   not once per assistant turn, so there is no live per-turn signal to hang a
   counter off. A counter incremented at Stop would give every tool in a
   multi-turn cycle the same, wrong turn number.

A `ts`-nearest-Stop heuristic was considered and deliberately not built: parallel
tool calls, the cadence mismatch above, and skew between hook time and
assistant-message time each move a tool call into the wrong turn's divisor, and
the symptom is a plausible-looking dollar figure on the wrong tool. P14-004 treats
`turn_number IS NULL` as "not attributed" rather than `$0.00` and ships a coverage
indicator, so the gap reads as a known gap.

Net: for `CLAUDE_CODE`, tool rows carry turn linkage for **imported** sessions and
not for live ones. Stop rows carry usage and `turn_number` on both paths.

## Acceptance criteria

- [x] A live Claude Code Stop produces `Stop` events carrying real
      `input_tokens` / `output_tokens` / `cache_read_tokens` /
      `cache_creation_tokens` and the model, with `cost_usd: 0`.
- [x] Anthropic's counts are passed through **undivided** — they are already
      disjoint, unlike OpenAI's and Google's, so subtracting would under-bill.
- [x] One Stop per assistant turn, `turn_number` 1-based and monotonic.
- [x] Live and import produce identical `(event_id, ts, turn_number, llm)` for the
      same turn, so a re-import cannot double-bill.
- [x] `parent_event_id` on import-path tool events names the issuing turn's Stop;
      NULL on the Stop itself and on non-tool events.
- [x] The second Stop reads only what is new; per-Stop cost is flat in session
      length.
- [x] Missing, truncated, locked, malformed or directory-shaped transcript, and an
      unusable session id, all degrade to the plain single Stop. Nothing throws.
- [x] No ingest change required — verified: `insert-events.ts` already computes
      `cost_usd` from any `llm` block and already persists both linkage columns.
- [x] `packages/db/src/seed.ts` produces the same turn structure.

## Files touched

- `apps/hook/src/lib/claude-turns.ts` — new; the one place a transcript entry
  becomes a turn (id seed, ts normalization, usage extraction). Shared by both
  paths so they cannot drift.
- `apps/hook/src/lib/tail-read.ts` — new; `readNewLines` moved out of `codex.ts`
  rather than copied.
- `apps/hook/src/adapters/claude-code.ts` — `mapBatch`, the cursor, the sweep.
- `apps/hook/src/adapters/codex.ts` — uses the shared tail read.
- `apps/hook/src/lib/import-synth.ts` — turn linkage; uses `claude-turns.ts`.
- `apps/hook/src/commands/import.ts` — `--since` skip path counts turns.
- `apps/hook/bench/hook.bench.ts` — real transcript for the Stop benchmark.
- `apps/hook/src/adapters/claude-code-usage.test.ts` — new.
- `apps/hook/src/lib/turn-linkage.test.ts` — new.
- `packages/db/src/seed.ts` — per-turn Stops with usage; tool rows linked.
- `DESIGN_DOC.md`, `apps/hook/AGENTS.md` — corrected where they described the old
  behaviour.

## Out of scope

- Cost attribution itself (P14-004 owns `apps/web/**`,
  `apps/ingest/src/jobs/**`, and the `0002_` / `0003_` migrations).
- Deriving turn linkage for live tool events by any heuristic — see above.
- The same `$0` gap in other adapters. **Copilot CLI has it**: `copilot.ts` is pure
  factory configuration and never builds an `llm` block, so Copilot sessions record
  `$0` exactly as Claude Code did. Not fixed here — it needs its own task and its
  own side channel, since Copilot's payload carries no usage either. (The other
  five are fine: codex and gemini-cli read side channels, opencode and the pi
  family read usage straight off the payload.)
- The residual event-count duplication between live and import **tool** events
  (different ids, so `ON CONFLICT` cannot dedupe them). Pre-existing, carries no
  money, and closing it needs the same transcript read the linkage gap does.

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test

# Per-turn usage, turn linkage, and the live/import id agreement
bun run --cwd apps/hook test src/adapters/claude-code-usage.test.ts
bun run --cwd apps/hook test src/lib/turn-linkage.test.ts

# Perf — must be run on real hardware, never trusted from CI
bun run --cwd apps/hook build
bun run --cwd apps/hook bench
PERF_TRANSCRIPT_TURNS=4000 bun run --cwd apps/hook bench   # cost stays flat
```

Measured on darwin/arm64, warm-start p50, base adapter vs this one under the
identical benchmark: `stop` 0.24ms → 0.28ms at 400 turns, 0.30ms at 4000 turns
(~2.9MB). The one-time full read on a session's first Stop: 1.3ms at 400 turns,
9.5ms at 4000.

**Not verifiable here:** anything needing a live database (`db:seed`, end-to-end
cost through ingest → `sessions.total_cost_usd`) or a live Claude Code session
(that the Stop payload's `transcript_path` is populated in practice, and that the
transcript's `message.usage` shape matches the fixtures).
