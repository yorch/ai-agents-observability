---
id: P13-003
title: Deterministic trajectory scorers
phase: 13
workstream: B
status: done
owner: claude
depends_on: [P13-001]
blocks: [P13-004]
estimate: M
---

## Goal

Add a set of deterministic, content-free scorers computed from the events hypertable
— retry loops, edit-thrash, redundant re-reads, denial→retry→success chains,
tests-run-before-merge, and step efficiency against a per-shape baseline — written as
`scores` rows with `source: deterministic`.

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§1.1 and §3.4 (R3). The 2026 agent-eval consensus is explicit: measure tool-call
correctness and trajectory shape with **deterministic code**, and reserve LLM judges
for genuinely nuanced dimensions. These scorers cost nothing per run, read no
transcript content, and every input is already stored:

- `events.tool_input_hash` — repeated identical calls are visible without ever storing
  the input (`DESIGN_DOC.md` §9.3: raw tool I/O is never stored server-side).
- `events.tool_exit_status`, `tool_was_denied`, `tool_was_interrupted`.
- `events.turn_number`, `parent_event_id`, and ordered rows — the trajectory is
  already reconstructable per session.
- `events.tool_name` / `tool_category` — `<agent>:<tool>` disambiguated (P8-001).

This is the workstream that makes the phase useful even if every judge idea is
dropped: it adds real signal with no privacy surface and no token spend.

**Agent-neutrality applies.** These scorers must branch on `agent_type` where tool
semantics differ, and must not hardcode Claude Code tool names.

## Acceptance criteria

- [x] Each scorer is a **pure function** over an ordered event list, unit-tested with
      fixture trajectories covering the happy path, the degenerate path (too few
      events), and at least one adversarial case (e.g. legitimate repeated reads of a
      file that genuinely changed).
- [x] Scorers implemented, each written as a `scores` row with its own
      `scorer_name` and `scorer_version`:
      - **retry loop** — repeated `tool_input_hash` within a session, weighted by how
        many repeats and whether the exit status changed
      - **edit-thrash** — the same target edited *n*× across a session
      - **redundant re-read** — re-reading content already read with no intervening
        write to it
      - **denial→retry→success** — a denied call retried and then succeeding
        (a permission-config smell, not a developer failing)
      - **tests-run-before-merge** — did the session invoke a test command before the
        linked PR merged (boolean, per session)
      - **step efficiency** — tool calls relative to a per-`shape_label` baseline
- [x] Every scorer returns **null rather than a number** below a minimum-volume
      threshold; no score is emitted for a session too small to characterize (the
      existing `frictionComponents` null-below-threshold behaviour is the precedent).
- [x] Scorers branch on `agent_type` where tool semantics differ; no user-facing
      string or scorer name hardcodes a specific agent.
- [x] Computation runs in the existing nightly `compute-effectiveness` job (or a
      sibling registered the same way), is idempotent per
      `(scorer_name, scorer_version)`, and is bounded in memory over a large backlog
      (keyset walk, per the `backfill-redaction` precedent).
- [x] No scorer reads a transcript, an S3 object, or any tool input/output content.
- [x] Scores are stored but **not yet surfaced on any dashboard** — display is
      P13-008's decision, after P13-007 says whether they mean anything.

## Post-rebase note (Phase 12 seam)

Phase 12 took the adapter seam from three agents to seven and extracted
`createStdinHookAdapter`. The capture these scorers depend on
(`tool_target_hash`, `tool_action`) therefore lives in the **shared**
`buildGenericToolInfo` and in the Pi/omp builder, not in Claude Code's own
builder — otherwise the three target-keyed scorers (edit thrash, redundant
re-read, tests-before-merge) would work for Claude Code and be silently dead for
Gemini CLI, Copilot CLI, Codex, Pi and omp. `stdin-hook-factory.test.ts` asserts
the derivation actually runs for a non-Claude agent rather than merely that the
keys exist.

`toolRole()` gained a shared layer of self-describing names (`read_file`,
`run_shell_command`, `apply_patch`, …) that resolve for any agent, because
enumerating seven-plus vocabularies by hand is not possible and guessing one is
worse than falling through. Per-agent tables still win, so an agent that reuses a
shared name for something else stays correct, and an unrecognised name still
resolves to `other` — a scorer that is silent for an agent is correct; one that
guesses is not.

## Implementation notes

- Put the pure functions in `packages/schemas/src/trajectory.ts` alongside
  `effectiveness.ts` so ingest and web share one definition, exactly as
  `FRICTION_WEIGHTS` is shared today.
- Each scorer gets its own `scorer_version` constant. They will move independently;
  a single phase-wide version would force spurious re-scores.
- The per-shape baseline for step efficiency should be derived from the data
  (e.g. a percentile of same-shape sessions) rather than hardcoded, and recorded in
  the score's `metadata` so a later reader can tell what it was measured against.
- Beware the obvious false positives, and encode them in tests: a repeated read after
  an edit is correct behaviour; a retry after a genuine transient failure is not
  thrash; a test command run once at the end is not "no tests."
- Reuse the existing single-query-per-batch approach in `compute-effectiveness`
  (histogram built in one query to avoid N+1) rather than fetching per session.

## Files touched

- `packages/schemas/src/trajectory.ts` (+ `trajectory.test.ts`)
- `packages/schemas/src/index.ts`
- `apps/ingest/src/jobs/compute-effectiveness.ts` (or a sibling job + `scheduler.ts`)

## Out of scope

- Any LLM judge, or any scorer that needs transcript content.
- Dashboard surfaces for these scores (P13-008).
- Changing `friction_score` to incorporate them. Tempting and wrong until P13-007
  says which of these predicts anything — folding an unvalidated signal into an
  already-unvalidated composite makes both harder to check.
- Real-time / in-hook computation. The hook's <10ms budget forbids it.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/schemas' test trajectory
bun --filter '@ai-agents-observability/ingest' test
bun run check
bun run typecheck
bun run build
bun run test
```
