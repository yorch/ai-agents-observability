---
id: P14-003
title: Claude Code per-turn usage capture and turn linkage
phase: 14
workstream: A
status: in-progress
owner: claude
depends_on: []
blocks: [P14-004]
estimate: M
---

> **STUB — renumbered, not yet written by its owner.**
>
> This file previously held the cost-attribution task. That work is now
> [`P14-004`](./P14-004-turn-linked-cost-attribution.md); `P14-003` is the
> **hook-side** half it consumes. The owner of the hook work fills this in.
> Do not treat the sections below as a specification — they record only the
> contract P14-004 was built against, so the two halves can be checked against
> each other.

## Goal

The Claude Code adapter emits, per assistant turn, a `Stop` event carrying that
turn's `llm` usage block plus `turn_number`, and links the tool events that turn
issued back to it. Without this, `events.turn_number` and
`events.parent_event_id` stay NULL and nothing downstream can attribute cost to
a tool call.

## The contract P14-004 was built against

- `events.turn_number` (INT) — 1-based, monotonically increasing within a
  `session_id`, one increment per assistant turn. Carried by the `Stop` event
  that holds the turn's `llm` usage and by the `PreToolUse` / `PostToolUse`
  events for the tools that turn issued.
- `events.parent_event_id` (UUID) — on a tool event, the `event_id` of the
  `Stop` event for the turn that issued it. NULL on the Stop event itself and on
  non-tool events.
- The `Stop` event for turn N carries model plus the four token counts, so
  ingest's existing cost path gives it a `cost_usd`.

Both columns already exist in the `events` DDL (`0001_init.sql`).

## Known partial delivery

The owner of this task reported, while P14-004 was in flight, that the **live**
hook path cannot carry `turn_number` / `parent_event_id` on tool events:
`PreToolUse` / `PostToolUse` fire in separate short-lived processes *before* the
turn's `Stop` hook, so the Stop event's id does not exist yet; and Claude Code's
`Stop` hook fires once per user-prompt response cycle rather than once per
assistant API turn, so there is no live per-turn signal to count. The **import**
path (`import-synth.ts`, reading the transcript JSONL) can carry both.

P14-004 degrades correctly under this: a tool event with a NULL `turn_number`
gets no attribution at all, and the dashboards show a coverage fraction rather
than a false `$0.00`. The consequence to record here is that for live Claude
Code sessions that fraction will be low until this gap is closed.

Deriving a tool→turn assignment heuristically (nearest following `Stop` by
timestamp) was **considered and declined** in P14-004: parallel tool calls, the
response-cycle-vs-API-turn mismatch, and hook-time vs assistant-message-time skew
all move a call into the wrong turn's divisor, and the symptom is a plausible
dollar figure attached to the wrong tool. If it is wanted, it is its own task
with its own error analysis.

## Out of scope

- The attribution arithmetic and the surfaces — [`P14-004`](./P14-004-turn-linked-cost-attribution.md).
- Sub-agent identification — [`P14-001`](./P14-001-subagent-identification-fix.md).
- The tool-category taxonomy — [`P14-002`](./P14-002-tool-category-taxonomy.md).
