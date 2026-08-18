---
id: P12-010
title: Price-table refresh + provider-correct token accounting
phase: 12
workstream: B
status: done
owner: claude
depends_on: [P8-002, P12-001, P12-004, P12-005]
blocks: []
estimate: S
---

## Goal

Every agent that bills per token prices its current models correctly, and the token
counts those rates are applied to mean the same thing across providers.

## Context

Phase 12 gave four agents adapters and, per P8-002, **empty** price tables — the
right call at the time, because an empty table bills `$0` *via the table* and
increments `unknown_model_events_total`, rather than mispricing against another
agent's model names. That was always meant to be temporary.

Two problems had accumulated by the time it was picked up:

1. **The two populated tables had gone stale, and one was wrong from the start.**
   `codex` stopped at the GPT-4o / o1 / o3 era, so every current Codex turn
   (`gpt-5.4`, `gpt-5.3-codex`) fell through to `$0`. `claude_code` priced
   `claude-opus-4-6` and `claude-opus-4-7` at `$15/$75` — the *retired* Opus 4.1
   rate; both launched at `$5/$25`, so those sessions read 3× high. Haiku 4.5 sat at
   the retired Haiku 3.5 rate (`$0.80/$4.00` vs `$1.00/$5.00`), and the Claude 5
   family was absent entirely. `opencode` carried the same wrong Haiku row.

2. **`computeCostUsd`'s four-rate model assumes disjoint token counts, and only
   Anthropic reports them that way.** Anthropic's `input_tokens` excludes both cache
   counters. OpenAI's `input_tokens` is the whole prompt *including* the cached-read
   and cache-write tokens; Google documents `promptTokenCount` as "the total
   effective prompt size ... includes the number of tokens in the cached content".
   Passing either straight through bills the cached tokens twice — once at the
   discounted cache rate, again at full input rate. Gemini has the mirror-image bug:
   `thoughtsTokenCount` bills at the output rate but sits *outside*
   `candidatesTokenCount`, so reasoning turns under-reported.

Filling the tables without fixing (2) would have shipped confidently wrong numbers,
which is worse than the `$0` it replaced.

## Acceptance criteria

- [x] `claude_code` carries current Anthropic first-party rates for the Claude 5
      family, Opus 4.5–4.8, Sonnet 4.5/4.6, Haiku 4.5 and the legacy 3.x snapshots.
      A test asserts the 5-minute cache write is `1.25×` input and a cache hit
      `0.1×` input for **every** row, so the next refresh cannot half-land.
- [x] `codex` prices the models Codex CLI actually runs today (`gpt-5.4`,
      `gpt-5.4-mini`, `gpt-5.3-codex`, the `gpt-5.6` family), keeping the older rows
      that still have published rates so historical events resolve.
- [x] `gemini_cli` is populated from Google's paid tier.
- [x] `pi` and `omp` are populated. Both are provider-agnostic, so each carries the
      union of the three providers whose rates are sourceable, at list prices.
- [x] `opencode` refreshed the same way, and keeps its dated `claude-*-2025*` keys so
      events priced before the refresh still resolve.
- [x] `copilot` stays **empty on purpose**, with the reasoning in its `_comment` and
      a test pinning it there: Copilot bills premium requests against a seat
      allowance ($0.04 overage per request, times a per-model multiplier), not
      tokens. A per-mtok row would invent a number no Copilot user is charged.
- [x] `codex.ts` subtracts the cached and cache-write tokens from OpenAI's inclusive
      `input_tokens`, clamped at 0.
- [x] `gemini-cli.ts` subtracts `cachedContentTokenCount` from `promptTokenCount` and
      adds `thoughtsTokenCount` to output.
- [x] `computeCostUsd` falls back to the bare model name when a key carries an
      OpenRouter-style `<provider>/` prefix — exact keys still win, so a table can
      price a prefixed name differently by listing it verbatim.
- [x] A test asserts every token-billed agent prices at least one model, and that no
      row has a cache-read rate above its input rate or a cache-write rate below it.

## Implementation notes

Rates were read from primary sources on 2026-08-18 and each table's `_comment`
records its source URL and retrieval date:

- <https://platform.claude.com/docs/en/about-claude/pricing>
- <https://developers.openai.com/api/docs/pricing>
- <https://ai.google.dev/gemini-api/docs/pricing>
- <https://docs.github.com/en/copilot/concepts/billing/copilot-requests>

Normalization belongs in the **adapter**, not in `cost.ts`. The cost function is
agent-neutral by design; an `if (agent === …)` there would be the seam leaking.

Nothing records a price-table version per event, so a rate correction is a data
update: bump `generated_at`, keep `version`, keep the filename. The "keep old
`v<N>` files" rule applies to *structure* changes, not price changes.

## Files touched

- `apps/ingest/src/data/price-table.{claude_code,codex,gemini_cli,pi,omp,opencode,copilot}.v1.json`
- `apps/ingest/src/lib/cost.ts` (+ new `apps/ingest/test/cost.test.ts`),
  `apps/ingest/test/price-tables.test.ts`
- `apps/hook/src/adapters/codex.ts`, `gemini-cli.ts` + their tests
- `DESIGN_DOC.md` §6.7 / §11.6 — both described cost as computed *client-side*,
  which has not been true since the adapters started emitting `cost_usd: 0`
- `apps/ingest/AGENTS.md`, `apps/hook/AGENTS.md`

## Out of scope

- A request-denominated cost model for Copilot. Real, but it needs a schema this
  one cannot express — `PriceTableSchema` is per-mtok only.
- Prompt-size tiering (Google charges more above a 200k-token prompt) and
  Anthropic's 1-hour cache write. One rate per model; the `_comment`s say which
  tier was chosen and which way it errs.
- Provider rates we cannot source: Groq, Ollama, self-hosted endpoints. Those
  models bill `$0` and land in `unknown_model_events_total`, as designed.
- Backfilling `events.cost_usd` for already-ingested rows. The `reconcile-cost` job
  is the existing surface for that decision; this task only fixes forward.

## Verification

```bash
bun run --cwd apps/ingest test
bun run --cwd apps/hook test
bun run check && bun run typecheck && bun run build && bun run test
```
