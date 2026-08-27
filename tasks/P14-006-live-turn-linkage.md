---
id: P14-006
title: Close live-session turn linkage
phase: 14
workstream: A
status: review
owner: claude
depends_on: [P14-003, P14-004]
blocks: []
estimate: M
---

## Goal

A tool call captured **live** knows which assistant turn issued it, by the same
definition an imported one does — so P14-004's per-tool, per-skill and
per-sub-agent cost attribution stops being an imported-sessions-only feature.

## The investigation that gated the task

P14-003 shipped with a documented partial delivery: live `PreToolUse` /
`PostToolUse` events carry NULL `turn_number` and NULL `parent_event_id`, for two
independent and correct reasons — the tool hooks are separate processes that fire
*before* their turn's `Stop` exists, and Claude Code's `Stop` fires once per
response **cycle**, not per assistant **turn**, so no live counter can be right.
A `ts`-nearest-`Stop` heuristic was proposed and rejected by two independent
reviews before this task, and is rejected again here.

**The question this task had to answer first was whether Claude Code's tool-hook
payload carries a stable per-call identifier.** If it does, ingest can join live
tool events to transcript-derived linkage on a natural key, with no heuristic and
no I/O on the hot path. If it does not, there is nothing sound to build and the
honest outcome is to say so.

### Finding: it does. `tool_use_id`, required, on both tool hooks.

Two independent lines of evidence, neither from memory:

1. **The official hooks documentation** (`code.claude.com/docs/en/hooks`) lists
   `tool_use_id` — "unique identifier for this specific tool call" — among the
   fields sent to `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
   `PermissionRequest` and `PermissionDenied`, and shows it in the worked
   `PreToolUse` example as `"tool_use_id": "toolu_01ABC123..."`.

2. **The shipped binary's own schema**, read out of the installed Claude Code
   2.1.247 executable — the authority the docs describe. Its hook-input
   definitions are, verbatim:

   ```js
   hook_event_name: n("PreToolUse"),  tool_name: e(), tool_input: d(), tool_use_id: e()
   hook_event_name: n("PostToolUse"), tool_name: e(), tool_input: d(),
                                      tool_response: d(), tool_use_id: e(), duration_ms: o().optional()
   ```

   `e()` is a required string; `o().optional()` is how the same file spells an
   optional. So `tool_use_id` is **required**, not best-effort, on both hooks.

The other half of the key was already proven: `import-synth.ts` keys its
`toolNameMap` on the `tool_use` block's `id` from the transcript, and a real
1188-line session on this machine confirmed 162 `tool_use` blocks each carrying a
`toolu_…` id, one-to-one with its 162 `tool_result` blocks. **The hook payload and
the transcript spell the same call the same way**, which is what makes the join
exact rather than approximate.

Two smaller findings from the same read:

- The id was **already on the wire**. `CLAUDE_KNOWN_KEYS` did not list it, so it
  fell through `buildMetadata`'s unknown-key passthrough into `events.metadata`
  and has been stored on every live Claude Code tool row all along — unpromoted,
  unindexed, and unused.
- Redaction does not touch it. Running `packages/redaction` over that real
  transcript preserved all 164 distinct `toolu_` ids and all 848 entry `uuid`s
  (only the `email` rule fired). The key survives the S3 path too, so a future
  transcript-side derivation remains open even though this task did not need one.

## What was built

### The join key, on both halves

- `ToolInfoSchema.tool_use_id` (`packages/schemas`) — the agent's own per-call id.
  Opaque: never parsed, only compared, and only ever within one `session_id`.
- `buildClaudeToolInfo` promotes it off the payload; `tool_use_id` joins
  `CLAUDE_KNOWN_KEYS` so it is captured structurally instead of duplicated into
  metadata. The other five tool-block builders set `null` — adopting the key is a
  per-adapter decision, and an id whose agent has no transcript counterpart would
  be a column nothing can join on.
- `claude-turns.ts` gains `toolUseIdsOf(entry)` and `TOOL_USE_IDS_METADATA_KEY`.
  The live Stop path and the import path both write `metadata.tool_use_ids` — the
  ids that turn issued, **ids only**, no tool name and no input, so the list stays
  content-free and needs no redaction pass.

### The server-side join

`packages/db/sql/migrations/0004_live_turn_linkage.sql` adds `events.tool_use_id`
with a partial index on `(session_id, tool_use_id)`, and redefines
`interactive_events` (a `SELECT *` view Postgres froze at creation time).

`apps/ingest/src/lib/turn-linkage.ts` is the definition, as a pure function;
`apps/ingest/src/jobs/link-turn-events.ts` is the plumbing. Over settled sessions
in a 7-day window it reads the tool rows still missing linkage and the Stop rows
that claim ids, resolves them, and writes `turn_number` + `parent_event_id` one
hypertable chunk at a time. Scheduled 06:10, five minutes before
`compute-cost-attribution` at 06:15, which selects on exactly what it writes.

## Why the linkage is derived in the hook and joined in ingest

Three placements were possible. All three were evaluated.

| Where the `tool_use_id → turn` map comes from | Cost | Verdict |
|---|---|---|
| The tool hook itself | Forbidden — a tool-lifecycle hook may not read a file (`apps/hook/AGENTS.md`), and `PreToolUse` fires orders of magnitude more often than `Stop` | Ruled out before the task began |
| Ingest, parsing the S3 transcript | An S3 GET + zstd decompress + full JSONL parse per settled session, **and** a second copy of the turn-ordinal rule in a workspace that cannot import `claude-turns.ts` | Rejected — see below |
| The Stop hook, off lines it already parses | 0.008 ms for a whole 323-turn transcript | **Chosen** |

The transcript-in-ingest route is the one the task brief proposed, and it has one
genuine advantage: it would light up sessions captured by a hook older than this
change, since `metadata.tool_use_id` was already being stored. That advantage is
worth little here — the project is pre-deployment, so there is no history to
backfill — and it is bought with the exact duplication `claude-turns.ts` exists to
prevent. That module's header says why: two callers deriving turns from the same
file "MUST agree byte-for-byte", because disagreement double-bills a session
permanently. Adding a third copy of the ordinal rule in another workspace, with no
type to bind them, is how that agreement ends.

Deriving at Stop keeps one definition of a turn, adds no I/O anywhere, and needs
no S3 read in the job at all. What ingest owns is the part that genuinely cannot
happen on the client: joining two rows that arrived in different requests.

Within ingest, a **job** rather than an inline UPDATE on the events route. Inline
would usually work — tool hooks fire before the Stop and the queue is FIFO — but
"usually" is the wrong guarantee for money, a late row would stay unlinked forever
with nothing to revisit it, and an inline write would have to duplicate the
compressed-chunk handling `lib/hypertable-chunks.ts` already provides. Timeliness
buys nothing: the only consumer is itself a nightly job over settled sessions.

## The contract, unchanged

`turn_number` is 1-based and monotonic per session, one increment per assistant
turn. `parent_event_id` on a tool event is the `event_id` of that turn's `Stop`.
This task introduces **no second semantic** — a joined row is indistinguishable
from an imported one, which is the whole point.

Guards that keep it that way:

- The job selects and writes only where `turn_number IS NULL` (both in the read
  and again in the `UPDATE`), so a **captured** linkage always beats a derived one
  and an imported session is never touched.
- A contested id resolves to the first claiming turn, deterministically, so two
  runs cannot disagree about which turn a dollar belongs to.
- An id no Stop claims stays NULL and is counted into the run's `unresolvedIds`.
  NULL means "not attributed", never `$0.00` — P14-004 already reads it that way.
- Nothing in the job touches `sessions.total_cost_usd`, `pr_rollups`, the
  continuous aggregates, or the two attribution columns. A test asserts it.

## Acceptance criteria

- [x] Claude Code's live tool-hook payload is **proven** to carry a stable
      per-call id, from the shipped binary's own schema and the published docs.
- [x] That id is promoted onto the tool block and persisted as
      `events.tool_use_id`, not left in metadata where no index can reach it.
- [x] Each turn's Stop carries the ids that turn issued, on both the live and the
      import path, with no transcript content alongside them.
- [x] Ingest joins the two on `(session_id, tool_use_id)` and writes the P14-004
      contract verbatim.
- [x] No heuristic and no clock: parallel calls and out-of-order timestamps place
      identically. Pinned by a test built from the exact shape the rejected
      heuristic got wrong.
- [x] Idempotent, order-independent, and unable to overwrite captured linkage.
- [x] The metadata key cannot drift between the two workspaces that spell it —
      the ingest test reads the hook's source and fails if it does.
- [x] Hot path untouched; the Stop-path addition measured at 0.008 ms over a real
      323-turn transcript.
- [x] Four gates green.

## Files touched

- `packages/schemas/src/event.ts` — `ToolInfoSchema.tool_use_id`.
- `apps/hook/src/lib/payload.ts` — promotes it; `CLAUDE_KNOWN_KEYS`.
- `apps/hook/src/lib/claude-turns.ts` — `toolUseIdsOf`, `toolUseIdsMetadata`,
  `TOOL_USE_IDS_METADATA_KEY`; `AssistantTurn.toolUseIds`.
- `apps/hook/src/adapters/claude-code.ts` — the live Stop carries the ids.
- `apps/hook/src/lib/import-synth.ts` — the import Stop carries the same ids;
  imported tool rows carry `tool_use_id`.
- `apps/hook/src/adapters/{stdin-hook-factory,codex,opencode,pi-family}.ts` —
  `tool_use_id: null`, with the reason.
- `packages/db/sql/migrations/0004_live_turn_linkage.sql` — new column, partial
  index, `interactive_events` replaced.
- `apps/ingest/src/lib/insert-events.ts` — persists the column.
- `apps/ingest/src/lib/turn-linkage.ts` — new; the definition.
- `apps/ingest/src/jobs/link-turn-events.ts` — new; the job.
- `apps/ingest/src/jobs/scheduler.ts` — registered, seeded at 06:10.
- `apps/hook/src/lib/turn-linkage.test.ts`,
  `apps/ingest/test/turn-linkage.test.ts` — the assertions.
- `DESIGN_DOC.md`, `apps/hook/AGENTS.md`, `apps/ingest/AGENTS.md`,
  `packages/db/AGENTS.md` — corrected where they described the old behaviour.

## Expected coverage, and how to measure it

P14-004 measures coverage as the share of `PostToolUse` rows carrying a non-NULL
`turn_number`. For Claude Code sessions captured by a hook at or after this change
and settled before the nightly run, expect that to go from **0% to near-100%** —
"near", not "100%", because these leave rows legitimately unlinked:

- a turn whose transcript line was truncated or unreadable when the Stop hook ran
  (the Stop degrades to a usage-less single event and claims no ids);
- a session whose final cycle never fired `Stop` (crash, kill), so its last turn's
  calls have no claimant;
- tool events from an agent other than Claude Code — six of the seven have no
  per-call id yet and are unaffected either way.

The direct measurement is the job's own log line: `rows` versus `unresolvedIds` on
a `link-turn-events: applied` record, per run. A persistently non-zero
`unresolvedIds` is the signal to look at, and it is deliberately a count rather
than silence.

## Out of scope

- Adopting the key for the other six agents. Each needs its own side channel with
  a counterpart to join against; a per-call id with nothing to match it is dead
  weight.
- Backfilling sessions captured before this change. Possible — the id was already
  being stored in `events.metadata`, and the S3 transcript survives redaction
  intact — but it needs the transcript-parsing path this task deliberately did not
  build, and the project is pre-deployment.
- The residual event-count duplication between live and import **tool** events
  (different ids, so `ON CONFLICT` cannot dedupe). Pre-existing, carries no money.
  This task does make it cheaper to close: both paths now write the same
  `tool_use_id`, so it is a resolvable key rather than a guess.
- `PostToolUse.duration_ms`. The binary's schema shows Claude Code sends it, and
  `buildClaudeToolInfo` still hard-codes `duration_ms: 0`. Real per-tool durations
  for free, but a separate change with its own consumers.
- `Stop.last_assistant_message`. Claude Code sends it, it is not in
  `CLAUDE_KNOWN_KEYS`, so **assistant prose is being copied verbatim into
  `events.metadata`**, which is not a redacted surface. Pre-existing, unrelated to
  this task, and worth its own task.

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test

bun run --cwd apps/hook test src/lib/turn-linkage.test.ts
bun run --cwd apps/ingest test turn-linkage

# Perf — real hardware only, never trusted from CI
bun run --cwd apps/hook build && bun run --cwd apps/hook bench
```

**Not verifiable here:** anything needing a live database — that
`0004_live_turn_linkage.sql` applies, that the partial index is chosen, that the
job's `UPDATE … FROM (VALUES …)` writes what its unit tests say, and that
`compute-cost-attribution`'s coverage actually rises on the next run. And anything
needing a live Claude Code session — that a real `PostToolUse` payload's
`tool_use_id` matches the transcript id byte-for-byte in practice. The binary's
own schema and a real transcript are the strongest evidence obtainable without
both.
