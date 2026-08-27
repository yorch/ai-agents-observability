---
id: P14-016
title: Reopen Copilot CLI token capture
phase: 14
workstream: A
status: done
owner: claude
depends_on: [P14-007, P14-015]
blocks: []
estimate: S
---

## Goal

P14-007 closed Copilot CLI token-usage capture as a well-evidenced negative on
2026-08-26, on the premise that even a captured token count would price at
`$0` — Copilot billed a per-seat premium-request allowance, not tokens. That
premise stopped being true on 2026-06-01 (recorded in P14-015): GitHub now
bills token-metered AI credits with published per-model rates, so a captured
count would price correctly today. This task re-runs the investigation on
that changed premise, to determine whether it is now buildable.

## Finding: still not reachable

Re-verified 2026-08-27, on stronger evidence than P14-007 had available.

### What changed since P14-007 (2026-08-26)

- **Nothing in what a hook can reach.** `docs.github.com/en/copilot/reference/
  hooks-reference`, fetched fresh today, documents the same 14 events with the
  same field lists as P14-007 found. No hook payload — `agentStop` included —
  carries a token, usage, or model field.
- `github/copilot-cli#3551` (the open request to formalize `events.jsonl` as a
  public integration point, cited by P14-007) is still open, opened
  2026-05-28, with no GitHub response or commitment.

### What's new: ground truth from the shipped binary, not just the docs website

P14-007's evidence was GitHub's documentation site. This machine has GitHub
Copilot CLI installed (`~/.copilot/pkg/darwin-arm64/0.0.423/`), so this task
checked the actual shipped artifact — the technique the task brief pointed at,
by analogy to how Claude Code's hook schema was originally extracted from its
own binary.

1. **The `agentStop` hook-payload builder, read directly out of the bundled
   `index.js`**, constructs exactly `{ timestamp, cwd, sessionId,
   transcriptPath, stopReason }`. This *confirms* the documentation rather
   than contradicting it — the strongest form of confirmation available
   (shipped code, not prose that could drift from it).
2. **The bundle ships its own `schemas/session-events.schema.json`**
   (6,369 lines), a Zod-derived JSON Schema for the CLI's internal event bus.
   It defines two usage-shaped events, and both were checked field-by-field:
   - `assistant.usage` — genuinely rich, PER-TURN usage: `model`,
     `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
     `cost`, `duration`. This is the same event P14-007 identified as
     belonging to the Copilot SDK's streaming surface. The schema's own
     `ephemeral` field is `"const": true`, and its description reads *"When
     true, the event is transient and not persisted to the session event log
     on disk."* That is confirmation, from the artifact itself, that this
     event never reaches any file a hook subprocess could read — P14-007's
     "different process's internal event bus" characterization was correct,
     now with the schema's own words saying so.
   - `session.shutdown.data.modelMetrics` — SESSION-TOTAL usage, keyed by
     model, `requests: { count, cost }` plus `usage: { inputTokens,
     outputTokens, cacheReadTokens, cacheWriteTokens }`. This is a formalized
     version of what P14-007 called the undocumented `events.jsonl`
     `session.shutdown` entry that third-party tools reverse-engineer.
3. **P14-007's fourth reason for declining `events.jsonl` — two third-party
   sources disagreeing on whether it is reliably persisted — is now resolved,
   and resolved in the negative.** Two independent checks, both pointing the
   same way:
   - **Empirical**: this machine's `~/.copilot/session-state/` holds ten real
     session directories spanning 2026-01-29 through 2026-08-06 — real,
     repeated use of the CLI, not a fresh install. None of them contains an
     `events.jsonl` file. Every one has only `checkpoints/`, `files/`,
     `research/`, and `workspace.yaml`.
   - **GitHub's own tracker**: `github/copilot-cli#1394` ("Persist usage
     statistics (currently only shown once when CLI exits)"), filed *after*
     the June 2026 billing switch and still open, states directly: session
     totals are "only shown once to the user but not persisted in
     `events.jsonl` or other files." That is GitHub confirming the negative
     P14-007 could only leave as a dispute.

So the picture sharpens rather than reverses: `events.jsonl` is not merely
undocumented — on the one real install available to check it against, and per
GitHub's own open issue about it, session-total usage is not persisted
anywhere a hook could read it *at all*, let alone per-turn.

### What Copilot resolves its model from (unchanged from P14-015)

Re-confirmed, not re-derived: (highest priority first) a custom agent
definition, `--model`, `COPILOT_MODEL`, `~/.copilot/settings.json`, then an
unnamed default. No hook payload names any of these. `~/.copilot/
settings.json` on this machine holds `"model": "claude-sonnet-4.5"` — but that
key is present only because the user configured it; nothing guarantees it is
set, and even where set it can be overridden per-session by the higher-priority
sources a hook cannot see. An inferred model was already rejected by P14-015
as worse than pricing nothing; this task did not revisit that call, because
tokens remain unreachable regardless of what prices them.

## Net

**Tokens: unreachable, documented and undocumented alike.** The billing
change that motivated reopening this is real and is recorded in P14-015 and
in `price-table.copilot.v2.json` — Copilot spend would price correctly the
moment a token count arrived. It is still blocked on the one thing this task
set out to re-check, and the re-check holds: no surface a hook process can
read — 14 documented hook events, the SDK's `assistant.usage`, or the
undocumented `events.jsonl` — carries it.

**Nothing built.** `apps/hook/src/adapters/copilot.ts` still emits no `llm`
block; `apps/hook/src/adapters/copilot.test.ts`'s existing pin (a payload
carrying usage-shaped fields Copilot does not actually send still produces no
`llm` block, and `mapBatch` stays `undefined`) already covers this and needed
no change. The comment block in `copilot.ts` gained a P14-016 section
recording this investigation's evidence, and `tasks/P14-007-copilot-usage-
capture.md` gained a "Reopened and re-closed" section pointing here.

## Acceptance criteria

- [x] Every surface P14-007 examined re-checked against current sources, and
      each one's changed/unchanged status stated: hook payload shapes (14
      documented events), `transcriptPath`, the SDK's `assistant.usage`, and
      `events.jsonl`.
- [x] P14-007's four stated reasons for declining `events.jsonl` re-examined;
      the reliability-dispute reason resolved with new evidence rather than
      left standing.
- [x] The shipped-artifact technique applied: this machine's installed
      Copilot CLI binary and bundled schemas inspected directly, not assumed
      unavailable.
- [x] No fabricated usage or model. `copilot.ts` still emits no `llm` block;
      the existing pin in `copilot.test.ts` still holds.
- [x] `apps/ingest`, `packages/db` untouched — sibling-task boundary held.
- [x] `tasks/INDEX.md` untouched, per the task's own scope note.
- [x] Four gates green; comment/doc-only change, so no perf regression is
      possible.

## Files touched

- `apps/hook/src/adapters/copilot.ts` — comment addendum only (P14-016
  section). No behavior change.
- `tasks/P14-007-copilot-usage-capture.md` — "Reopened and re-closed" section
  appended; original findings left intact.
- `tasks/P14-016-copilot-token-capture-reopened.md` — this file.

## Out of scope

- Everything P14-007 and P14-015 already scoped out: transcript shipping off
  `transcriptPath`, a request-denominated cost model beyond what P14-015
  built, and Copilot cost surfaces outside `/org/agents` and
  `/admin/price-tables`.
- Filing or commenting on `github/copilot-cli#1394` / `#3551` upstream — noted
  here as evidence, not acted on.
- Re-opening this again absent a concrete change: either issue closing, a hook
  payload documenting a usage field, or GitHub formalizing `events.jsonl`.

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test   # all green
bun run --cwd apps/hook test src/adapters/copilot.test.ts             # unchanged, still green
```

## What could not be verified here

- **A live Copilot CLI session run specifically for this task.** The evidence
  above comes from this machine's *existing* `~/.copilot/` state (an
  installed binary, its bundled schemas, and ten real prior sessions) and from
  GitHub's own documentation and issue tracker — not from a session started
  and torn down to watch `events.jsonl` (or its absence) happen live.
- **Whether `COPILOT_EVENTS_LOG_DIRECTORY` (an env var referenced elsewhere in
  the bundled `index.js`, gating a differently-shaped `events.<N>.jsonl`
  writer used by GitHub's hosted coding-agent product) has any relationship to
  the local CLI's `~/.copilot/session-state/<id>/events.jsonl` path. The two
  did not appear to be the same code path on inspection, but this was not
  proven by tracing every call site, and the empirical result (zero files
  either way, on a stock install with the var unset) makes the distinction
  moot for this task's conclusion.
- **Anything needing a live database or Docker.** Not applicable — no ingest
  or db change was made.
