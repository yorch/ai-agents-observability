---
id: P14-007
title: Copilot CLI token-usage capture
phase: 14
workstream: A
status: done
owner: claude
depends_on: [P14-003]
blocks: []
estimate: S
---

## Goal

Establish where GitHub Copilot CLI's token usage actually lives, and capture it
onto the turn-completion event the same way P14-003 did for Claude Code — if a
hook-reachable source exists.

## Context

P14-003 fixed the identical `$0`-forever symptom for Claude Code and flagged, but
deliberately did not fix, the same shape of gap in Copilot: `copilot.ts` never
builds an `llm` block, so `insert-events.ts` computes no `cost_usd` and
`upsert-session.ts` accumulates `$0` — the same chain, verified again here.

Unlike Claude Code, Codex and Gemini CLI — which each had a real, documented or
directly observable side channel a hook could read — **Copilot CLI does not**.
This task is the investigation that established that, and a documentation-only
change recording it, not a usage-capture feature.

## What was found

Checked against GitHub's current Copilot CLI documentation (WebFetch/WebSearch,
2026-08-26 — not assumed from P12-006's research, which predates this):

1. **No hook payload carries usage.** `docs.github.com/en/copilot/reference/
   hooks-reference` was fetched directly and gives the exact JSON shape of every
   hook, including `agentStop` (the turn-completion hook `copilot.ts` maps to
   `Stop`): `{ sessionId, timestamp, cwd, transcriptPath, stopReason,
   stop_hook_active }`. No hook — `agentStop` included — carries a token, usage,
   or model field. Confirmed on two independent fetches of the same page.
2. **`transcriptPath` is new since P12-006** — `agentStop`, `preCompact` and
   `subagentStop` now document it, where P12-006's research (Aug 2026) found
   none. `copilot.ts`'s comment claiming "Copilot's documented payload carries no
   transcript path" was stale; corrected in this task. It does not carry usage,
   though, so it does not close this gap — see below.
3. **The rich per-call usage event Copilot does emit (`assistant.usage`: model,
   `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
   `reasoningTokens`, `cost`) is real, but it belongs to the separate Copilot
   *SDK*'s** opt-in streaming/RPC surface for custom Copilot-based applications
   (`docs.github.com/en/copilot/how-tos/copilot-sdk/features/{streaming-events,
   usage-and-billing}`), not to the CLI or its hooks. A stdin-hook adapter spawned
   by the CLI cannot reach it — it is a different process's internal event bus.
4. **An undocumented internal file exists** — the CLI writes its own session log
   to `~/.copilot/session-state/<id>/events.jsonl` (this is very likely, but not
   confirmed, what `transcriptPath` names). Third-party tools
   (`github.com/tokentopapp/agent-copilot-cli`, `github.com/J-Bax/
   copilot-token-tracker`) reverse-engineer a `session.shutdown` entry there for a
   **session-total** usage aggregate, grouped by model. This was **not** used as
   the source, for four compounding reasons:
   - It is undocumented. `github/copilot-cli#3551` is an open upstream request
     asking GitHub to formalize `events.jsonl` as a public integration point —
     as of this writing it explicitly is not one.
   - The two third-party sources directly disagree on whether it is reliably
     persisted at all (one describes `session.shutdown` as ephemeral and never
     written; the other's tool depends on it being written and reports it present
     in ~87% of sessions sampled).
   - It is scoped to the **whole CLI session** (one entry, at true process exit),
     not to a turn — it could not satisfy "per-turn" the way every other
     adapter's usage capture does, only a much coarser session-level number.
   - Its schema already changed once (Copilot CLI's production implementation
     moved from TypeScript to Rust mid-2026, per the linked issues), with no
     stability guarantee for the next change.
5. **Independently of all of the above: `apps/ingest/src/data/
   price-table.copilot.v1.json` is intentionally empty.** Its own `_comment`
   explains why — Copilot bills a seat's premium-request allowance, not
   per-token, so filling in vendor per-token rates "would invent a number no
   Copilot user is ever charged." Even a captured token count would price at
   `$0` today, via the `unknown_model_events_total` / unpriced-models path
   (P12-011), not the `llm`-block-shaped gap this task set out to close. A
   request-denominated cost model is a separate, future task.

**Conclusion: a well-evidenced negative**, per the task's own escape hatch — not
an oversight, and not the same situation P14-003 found for Claude Code. No
hook-reachable source of token usage exists for Copilot CLI today.

## What changed

Nothing functional. `apps/hook/src/adapters/copilot.ts`:

- A new comment block records the investigation above, so the next person does
  not have to redo it (or worse, build on the undocumented `events.jsonl` side
  channel without knowing its reliability is disputed).
- The stale "no transcript path" comment on `transcriptTarget` is corrected:
  `transcriptPath` is now documented on three hooks; transcript shipping is
  still not wired, but for a different, deliberate reason (a separate decision
  from usage capture, with its own `packages/redaction` question) — not because
  no path exists.

`apps/hook/src/adapters/copilot.test.ts`:

- The "ships no transcript" test is retitled and now asserts against a payload
  that *includes* `transcriptPath`, so it can't be quietly satisfied by an
  absent field.
- A new test pins the negative finding: a payload carrying usage-shaped fields
  Copilot does not actually send (`inputTokens`, `usage`, `tokens`) still
  produces no `llm` block, and `copilotAdapter.mapBatch` is `undefined` — so a
  future change that starts reading one of those fields without re-verifying
  against Copilot's actual contract fails loudly here first.

## Acceptance criteria

- [x] The `$0`-for-every-session chain re-verified against current code
      (`insert-events.ts`, `upsert-session.ts`), not assumed from P14-003's
      writeup.
- [x] Copilot CLI's current hook/event documentation checked directly
      (WebFetch/WebSearch), not from memory or from P12-006's research.
- [x] Every documented hook payload shape checked for a usage/token/model field;
      none found, including on the turn-completion hook.
- [x] The one plausible side channel (`events.jsonl`) investigated and its
      reliability, scope and evidentiary basis stated, not assumed.
- [x] Price-table status confirmed and stated: Copilot's table is intentionally
      empty, so usage capture would not have produced non-zero cost regardless.
- [x] No fabricated usage. `copilot.ts` still emits no `llm` block, and a test
      pins that a look-alike but unsent field cannot silently start one.
- [x] Four gates green; no functional/runtime change, so no perf regression is
      possible (verified — see below).

## Files touched

- `apps/hook/src/adapters/copilot.ts` — comments only.
- `apps/hook/src/adapters/copilot.test.ts` — one test retitled/strengthened, one
  new test.

## Out of scope

- Anything in `apps/ingest`, `packages/db`, `apps/web` — untouched, per the
  sibling-task boundary.
- Wiring `transcriptTarget` off the newly-documented `transcriptPath`. That is a
  transcript-shipping decision, not a usage-capture one, and needs its own look
  at `packages/redaction`'s obligations before this adapter starts uploading
  anything.
- A request-denominated cost model for Copilot (multiplier × premium-request
  rate rather than per-token). The schema P8-002/P8-006 built assumes per-token
  billing; Copilot needs a different shape. Tracked nowhere yet — worth a task
  if Copilot cost visibility becomes a priority.
- Re-opening this if GitHub documents usage on a CLI hook payload, or formalizes
  `events.jsonl` (tracked upstream at `github/copilot-cli#3551`).

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test   # all green
bun run --cwd apps/hook test src/adapters/copilot.test.ts             # 15 tests
bun run --cwd apps/hook bench                                         # unchanged vs main (see PR body)
```

## Reopened and re-closed (P14-016, 2026-08-27)

The billing premise this task relied on — "Copilot does not bill tokens at
all" — stopped being true on 2026-06-01 (P14-015): GitHub now bills
token-metered AI credits and publishes per-model rates, so a captured token
count would price correctly today. That reopened the question of whether
capture is reachable. It re-closed negative, on stronger evidence than this
task had:

- GitHub's hooks reference, re-fetched 2026-08-27: unchanged — same 14
  events, no usage/token/model field anywhere.
- **New**: ground truth from the shipped Copilot CLI binary itself (installed
  on the machine that did this investigation), not just the docs website. Its
  `agentStop` hook-payload builder, read out of the bundled `index.js`,
  constructs exactly `{ timestamp, cwd, sessionId, transcriptPath,
  stopReason }` — confirming the docs.
- **New**: the bundle's own `schemas/session-events.schema.json` defines the
  rich per-turn `assistant.usage` event (model, input/output/cache tokens,
  cost) this task inferred belonged to the SDK — and the schema itself marks
  it `"ephemeral": true`, "not persisted to the session event log on disk".
  Confirmed structurally unreachable from a hook subprocess, not merely
  believed to be.
- **This task's 4th reason for declining `events.jsonl` — "two sources
  disagree on whether it's reliably persisted" — is now resolved, in the
  negative.** The same schema file defines `session.shutdown.data
  .modelMetrics` (a formalized version of what this task called
  undocumented), but it is empirically not written: zero `events.jsonl` files
  exist across ten real `~/.copilot/session-state/<id>/` directories on the
  investigating machine, spanning January–August 2026 of real use. GitHub's
  own `github/copilot-cli#1394` (opened after the June 2026 billing switch,
  still open) says directly why: session totals are "only shown once to the
  user but not persisted in events.jsonl or other files."
- `github/copilot-cli#3551` (formalize `events.jsonl`) is still open, no
  GitHub commitment — unchanged from this task's finding.

**Conclusion unchanged, evidence strengthened**: no hook-reachable source of
tokens or a model exists. Full writeup: `tasks/P14-016-copilot-token-capture-
reopened.md`. `apps/hook/src/adapters/copilot.ts` carries the same evidence in
a code comment for the next person who reopens this.

## What could not be verified here

- **Anything needing a live Copilot CLI session or its local files
  (`~/.copilot/session-state/`, `~/.copilot/logs/process-*.log`).** The finding
  that no hook payload carries usage is sourced from GitHub's own current
  documentation, fetched directly; the *characterization* of `events.jsonl` and
  its reliability is sourced from third-party reverse-engineering (GitHub issues,
  tool READMEs), not observed against a running session on this machine.
- **Anything needing a live database or Docker.** Not applicable — no ingest or
  db change was made.
