---
id: P14-010
title: Capture real per-tool durations
phase: 14
workstream: A
status: done
owner: claude
depends_on: []
blocks: []
estimate: M
---

## Goal

Stop hardcoding `tool_duration_ms` / `events.tool_duration_ms` to `0` on every
adapter that builds a tool block. Read a real duration where the payload
exposes one, and leave it `NULL` (unknown) — never a fabricated `0` — where it
doesn't.

## The defect

`buildClaudeToolInfo` in `apps/hook/src/lib/payload.ts` hardcoded
`duration_ms: 0` despite Claude Code's `PostToolUse` payload carrying a real
`duration_ms` field since Claude Code 2.1.119 (independently confirmed via
WebSearch; the binary at `~/.local/share/claude/versions/2.1.247` spells it
`duration_ms: o().optional()` in its own Zod hook-input schema, matching how
that same schema spells every other optional field — `o()` for optional
number, `e()` for required string).

A second, deeper defect sat underneath the first: `packages/schemas`'
`ToolInfoSchema.duration_ms` was `z.number().int().nonnegative().default(0)` —
**not nullable**. Even after wiring the real payload field through, an absent
value (the common case for six of seven adapters, and for any Claude Code
build older than 2.1.119) would have been coerced to `0` by the zod default,
because zod's `.default()` only distinguishes `undefined` from every other
value — it cannot express "send `null` through, don't substitute". Fixing only
`payload.ts` without widening the schema to `nullable().default(null)` would
have shipped a still-wrong number under a passing-looking diff.

`0` is not a neutral placeholder here: `AVG(tool_duration_ms)` and
`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tool_duration_ms)` (both used
throughout `apps/web/src/lib/*.ts`) exclude SQL `NULL` from the aggregate but
count a stored `0` as a real, instant measurement — so every unmeasured tool
call was dragging every average down and tying for fastest on every p95,
rather than being excluded the way an honestly-unknown value should be.

## Affected surfaces (fake latency, since the surface existed)

Every one of these reads `events.tool_duration_ms`, directly or via a scorer
that sums it, and was receiving either literal `0` from live capture or a
seed-only number with no real-capture counterpart:

- `/me/insights` — the tool-duration table and (per-slash-command) the p95
  duration column (`apps/web/src/lib/insights-queries.ts`).
- `/org/tools` and `/team/[slug]/tools` — "Avg duration" per tool
  (`org-queries.ts`, `team-queries.ts`).
- `/org/mcp` and `/team/[slug]/mcp` — MCP server avg + p95 latency
  (`org-queries.ts`, `team-queries.ts`).
- `/me/sessions` (and the per-session view) — avg tool duration
  (`sessions-queries.ts`).
- `subject-quality-queries.ts` — p95 duration feeding the quality/friction
  scorers.

All of the above were showing fake ($0-equivalent: all-zero) latency for as
long as the product has existed — there has never been a real capture path for
this field until this task.

## Per-adapter audit (evidence, not memory)

| Adapter | Path | Duration on the wire? | Evidence | Action |
|---|---|---|---|---|
| Claude Code | `lib/payload.ts` `buildClaudeToolInfo` | **Yes** — `duration_ms`, optional, PostToolUse only | Binary's own Zod hook schema (`o().optional()`); independently corroborated: WebSearch confirms `duration_ms` added to Claude Code's `PostToolUse`/`PostToolUseFailure` hook input "as of version 2.1.119" | Read it via `optionalNonNegativeInt(raw.duration_ms)`; added to `ClaudeCodeHookPayload` + `CLAUDE_KNOWN_KEYS` so it's captured structurally, not duplicated into `metadata` |
| Codex (native hooks) | `stdin-hook-factory.ts` `buildGenericToolInfo` | **No** | `learn.chatgpt.com/docs/hooks` (the current canonical location OpenAI's docs redirect to) fetched live: PostToolUse's documented field table is `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response` — no timing field | `duration_ms: null` (was `0`) |
| Codex (`notify`/rollout fallback) | `codex.ts` `toolInfo` | **No** | `codex-rollout.ts`'s `parseRolloutRecords` tracks name/byte-counts/denial per `function_call`↔`function_call_output` pair, no timestamp per call — same honesty already applied to `action: null` there | `duration_ms: null` (was `0`) |
| Gemini CLI | `gemini-cli.ts` → `buildGenericToolInfo` | **No** | `geminicli.com/docs/hooks/reference` fetched live: `AfterTool`'s documented input is `tool_name`, `tool_input`, `tool_response` (`llmContent`/`returnDisplay`/`error`), `mcp_context`, `original_request_name` — no timing field. (The CLI's own hook-invocation *log* records duration for its own bookkeeping; that is not exposed on the payload our hook receives.) | `duration_ms: null` (was `0`, via the shared factory) |
| Copilot CLI | `copilot.ts` → `buildGenericToolInfo` | **No** | `docs.github.com/en/copilot/reference/hooks-reference` fetched live: `postToolUse` is `{ sessionId, timestamp, cwd, toolName, toolArgs, toolResult }` — no timing field (matches P14-007's finding for usage, same page) | `duration_ms: null` (was `0`, via the shared factory) |
| Pi / OMP | `pi-family.ts` `buildToolInfo` | **No**, but read defensively | `pi-mono`'s own `docs/extensions.md` fetched live: `tool_result`'s documented shape is `toolName, toolCallId, input, content, details, isError, usage` — no duration field (the docs explicitly note a duration would have to be self-timed inside a custom tool). The code already read `raw.durationMs ?? raw.duration_ms` before this task — kept, since a future release or a custom `details` payload could carry it, but the read now goes through `optionalNonNegativeInt` instead of the token-count `num()` helper | `duration_ms` now `optionalNonNegativeInt(...)` instead of `num(...)` — absence was already silently becoming `0` via `num()`; now `null` |
| opencode | `opencode.ts` `buildToolInfo` | **No**, but read defensively | `sst/opencode`'s plugin type definitions fetched live: the `tool.execute.after` hook signature is `(input: {tool, sessionID, callID, args}, output: {title, output, metadata}) => Promise<void>` — no duration field, and opencode's own bus-event taxonomy (session/message/project/permission/lsp) does not include a `tool.*` entity at all, consistent with no such field existing on the wire this adapter's plugin forwards | Same fix as Pi/OMP: `optionalNonNegativeInt(raw.duration_ms)` instead of `num(raw.duration_ms)` |
| Import (`import-synth.ts`) | `buildImportToolInfo` | **No**, and not derivable | See "Import and the timestamp-diff question" below | `duration_ms: null` (was `0`) |

## Import and the timestamp-diff question

The task asked whether a duration is soundly derivable from transcript entry
timestamps for the importer. It is not, and the reason is concrete rather than
a general policy: `entryToEvents` synthesizes one `PostToolUse` per
`tool_result` **block**, and multiple `tool_result` blocks routinely share one
`user` entry (one batched turn reply) — so they'd all get the **same**
timestamp. A "duration" computed as `(that entry's ts) − (the issuing
assistant entry's ts)` would then assign the **identical** gap to every tool
call in the batch, regardless of how long each individually ran. A fast `Read`
batched alongside a 30-second test run would be stamped with the test run's
time — a plausible-looking number that is wrong for every call but the
slowest one in its batch. That is exactly the "approximation dressed as a
measurement" the task warned against, so `duration_ms` stays `null` on
imported tool events, with the reasoning recorded in `import-synth.ts`.

## The nullability fix (`packages/schemas`)

`ToolInfoSchema.duration_ms` changed from
`z.number().int().nonnegative().default(0)` to
`z.number().int().nonnegative().nullable().default(null)`. This is not the
"widen the schema to fit one adapter" anti-pattern `apps/hook/AGENTS.md` warns
against — it is the opposite: every adapter's tool-duration semantics were
already agent-neutral (some measure it, most don't), and the schema was the
one place forcing all of them onto the same wrong default. `events.tool_duration_ms`
itself needed no migration — the DB column (`packages/db/sql/migrations/0001_init.sql`)
was already a nullable `INT`; only the wire-contract zod schema was
non-nullable.

## The seed (`packages/db/src/seed.ts`) — checked, not changed

`insertEvents` generates a random `tool_duration_ms` (5–8000ms depending on
tool) for **every** `PostToolUse` row it writes, regardless of the row's
`agent_type`. That is a **shape mismatch** with what real capture now
produces: in production, only `CLAUDE_CODE` sessions will ever carry a
non-null `tool_duration_ms` (and only from a hook build ≥ 2.1.119) — the other
six agent types will have `NULL` there permanently until their vendors add a
timing field. Today's seed makes every seeded agent's duration dashboards
(`/org/tools`, `/org/mcp`, etc.) look populated for agents that in reality
will show "no data". Per the sibling-task boundary (`packages/db/src/seed.ts`'s
cost logic is being refactored concurrently), this is **reported, not fixed**:
`seed.ts` was read but not touched. A follow-up should gate `toolDurMs` on
`agentType === 'CLAUDE_CODE'` (or, more precisely, on a `duration_supported`
flag per agent, once one exists) and leave the column `NULL` for the rest.

## What changed

- `packages/schemas/src/event.ts` — `ToolInfoSchema.duration_ms` widened to
  nullable, default `null`.
- `apps/hook/src/lib/fields.ts` — new `optionalNonNegativeInt()`, the
  "absence/malformed ⇒ null" counterpart to the existing `num()` helpers that
  default to `0` (correct for a token count, wrong for a duration).
- `apps/hook/src/lib/payload.ts` — `buildClaudeToolInfo` now reads
  `raw.duration_ms` via `optionalNonNegativeInt`; `duration_ms` added to
  `ClaudeCodeHookPayload` and `CLAUDE_KNOWN_KEYS`.
- `apps/hook/src/adapters/stdin-hook-factory.ts` — `buildGenericToolInfo`'s
  `duration_ms: 0` → `null` (Codex native hooks, Gemini CLI, Copilot CLI).
- `apps/hook/src/adapters/codex.ts` — rollout-derived `toolInfo()`'s
  `duration_ms: 0` → `null`.
- `apps/hook/src/adapters/pi-family.ts`, `apps/hook/src/adapters/opencode.ts`
  — `duration_ms` now read with `optionalNonNegativeInt` instead of `num()`.
- `apps/hook/src/lib/import-synth.ts` — `buildImportToolInfo`'s
  `duration_ms: 0` → `null`, with the timestamp-diff rejection recorded inline.
- Tests: `apps/hook/src/lib/fields.test.ts` (new), and duration coverage added
  to `claude-code.test.ts`, `stdin-hook-factory.test.ts`, `codex.test.ts`,
  `gemini-cli.test.ts`, `copilot.test.ts`, `pi.test.ts`, `opencode.test.ts`,
  `import-synth.test.ts`, `packages/schemas/test/event.test.ts`.

## Acceptance criteria

- [x] Claude Code's real `duration_ms` is captured on `PostToolUse`, absent on
      `PreToolUse` and on older builds — never coerced to `0`.
- [x] Every other adapter audited against current vendor documentation
      (WebFetch/WebSearch, not memory); each finding has a cited source.
- [x] `ToolInfoSchema.duration_ms` nullable; `NULL` survives from adapter →
      wire → `insert-events.ts` → `events.tool_duration_ms` unchanged.
- [x] No DB schema change (`events.tool_duration_ms` was already a nullable
      `INT`).
- [x] Tests cover: duration present, duration absent (must not become `0`),
      malformed values (string/negative/NaN/Infinity/object/array/boolean/
      Symbol), and that a malformed value never throws (the always-exit-0
      guarantee, at the layer this task touches).
- [x] Conformance suite (`apps/hook/src/adapters/conformance.ts`,
      `metadata-content-free.test.ts`) still green for every adapter.
- [x] Seed checked for shape agreement with real capture; mismatch found
      (seed populates duration for every agent, production only ever will for
      Claude Code) and reported rather than fixed, per the sibling-task
      boundary on `seed.ts`.
- [x] Four gates green before every commit.
- [x] Hook perf benchmark run before and after; no measurable regression (see
      PR body for numbers).

## Files touched

- `packages/schemas/src/event.ts`, `packages/schemas/test/event.test.ts`
- `apps/hook/src/lib/fields.ts`, `apps/hook/src/lib/fields.test.ts` (new)
- `apps/hook/src/lib/payload.ts`
- `apps/hook/src/adapters/stdin-hook-factory.ts`,
  `apps/hook/src/adapters/stdin-hook-factory.test.ts`
- `apps/hook/src/adapters/codex.ts`, `apps/hook/src/adapters/codex.test.ts`
- `apps/hook/src/adapters/pi-family.ts`, `apps/hook/src/adapters/pi.test.ts`
- `apps/hook/src/adapters/opencode.ts`,
  `apps/hook/src/adapters/opencode.test.ts`
- `apps/hook/src/adapters/gemini-cli.test.ts`
- `apps/hook/src/adapters/copilot.test.ts`
- `apps/hook/src/adapters/claude-code.test.ts`
- `apps/hook/src/lib/import-synth.ts`, `apps/hook/src/lib/import-synth.test.ts`

## Out of scope

- `apps/ingest/src/lib/cost-attribution.ts` and `packages/db/src/seed.ts`'s
  cost logic — a sibling task's territory; not touched.
- Fixing the seed's duration/agent-type shape mismatch documented above — read
  and reported, not changed.
- Any new shared package.
- `tasks/INDEX.md` — this file is added standalone; the index is
  consolidated separately.

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test   # all green
bun run --cwd apps/hook test                                          # 471 pass, 0 fail
bun run --cwd apps/hook bench                                         # see PR body for before/after
```

## What could not be verified here

- **A live Claude Code session on a build ≥ 2.1.119** actually emitting
  `duration_ms` on the wire — the field's presence is sourced from the shipped
  binary's own Zod schema plus an independent corroborating changelog search,
  not from capturing a real hook invocation on this machine.
- **A live Pi/OMP/opencode session** whose `tool_result` payload might, in
  practice, carry a `durationMs`/`duration_ms` field despite it being
  undocumented — the defensive read stays in place for exactly this
  possibility, but nothing here proves or disproves it against a running
  session.
