---
id: P12-012
title: Generate the provider-agnostic price tables from the agents' own model catalog
phase: 12
workstream: B
status: done
owner: claude
depends_on: [P12-010, P12-011]
blocks: []
estimate: M
---

## Goal

A Pi, omp or opencode user who routes to any mainstream provider gets a real cost,
and the next refresh is a command rather than an afternoon of reading pricing pages.

## Context

P12-010 filled the three provider-agnostic tables by hand, from the three vendors
whose pages were easy to read: Anthropic, OpenAI, Google. About 34 models each.
That was already the wrong shape for these agents and the task said so — they
"drive any provider the user has credentials for" — but the scale of the gap only
became visible once P12-011 put the unpriced models on `/admin/price-tables`.
A Pi user on Groq, DeepSeek, Moonshot, Z.AI, Mistral, xAI or Alibaba billed `$0`,
which is most of the reason someone chooses a provider-agnostic agent.

Hand-maintaining a twenty-vendor union does not work. It is the same failure that
left `codex` stuck in the GPT-4o era: the table is correct the week it lands and
quietly wrong three months later, with nothing to signal the drift.

**models.dev is the catalog opencode itself builds its model list from.** Sourcing
from it fixes the alignment problem, not just the coverage one: the keys are by
construction the names the adapter reports. A correct rate filed under a name the
agent never emits prices nothing.

## Acceptance criteria

- [x] `scripts/gen-price-tables.ts`, wired as `bun run gen:price-tables`,
      regenerates `price-table.{pi,omp,opencode}.v1.json` from
      <https://models.dev/api.json>.
- [x] Coverage goes from ~34 models across 3 vendors to **243–244 across 20**.
      A test floors it at 150, so a catalog restructure that collapses the table
      fails rather than silently un-pricing everyone again.
- [x] Only **first-party vendors** are sourced. Aggregators (OpenRouter, Bedrock,
      Azure, Together, …) re-serve the same models under `<vendor>/<model>`, which
      `resolveModelPrice` already strips to the bare key — so they would add
      hundreds of rows differing only by the aggregator's margin.
- [x] `PROVIDERS` order is precedence, and every model served by two vendors is
      **printed** with both rates and which won. One today: `glm-5.2`, where
      Alibaba's cache-read is $0.02/Mtok above Z.AI's own.
- [x] Rows with no rate on one side are excluded — free/placeholder entries, and
      embedding/rerank models, which are priced per input token only and are never
      what an agent turn reports. A zero row is indistinguishable from an unpriced
      one on `/admin/price-tables`, so it must not be how a real rate is recorded.
- [x] Where a vendor documents no cache rate, cached tokens are charged as ordinary
      **input** — absent means "no known discount", not "free".
- [x] `--from <path>` regenerates from a saved catalog: reproducible pinning, and a
      way through a network Bun's `fetch` cannot reach models.dev on.
- [x] The generator runs biome over its own output, rather than reimplementing
      biome's key collation and failing `bun run check` on pure-whitespace diffs.
- [x] `opencode`'s dated `claude-*-2025*` keys are pinned by hand so events priced
      before this table existed still resolve.
- [x] A test asserts the generated tables **agree with the hand-maintained ones**
      on every shared model. It found a real disagreement on its first run (below).
- [x] `gemini-3.1-pro-preview-customtools` added to `gemini_cli` — Google's page
      quotes it on the same row as `gemini-3.1-pro-preview`, and Gemini CLI uses
      custom tools.
- [x] `/admin/price-tables` marks unpriced rows belonging to an agent whose table
      is empty **by design** as "billed per request, not per token", derived from
      the fetched tables rather than a hard-coded agent name.

## Implementation notes

**The cross-source test earned its place immediately.** models.dev had
`gemini-3.6-flash` at `$1.50/$7.50`, its rate from 2027-01-01; Google's page quotes
`$0.75/$3.75` "through December 31, 2026". Both are right, at different times. The
fix is `VENDOR_OVERRIDES` in the generator — deliberately tiny, and only for the one
thing a catalog structurally cannot carry: a promotional rate with an expiry date.
Without the test the two tables would have priced the same model differently
depending on which agent ran the session.

The catalog independently confirmed P12-010's hand transcription: `claude-opus-5`
5/25/6.25/0.5, `gpt-5.4` 2.5/15/0.25, `gemini-3.7-flash` 0.75/3.75/0.075 all match
what was read off the vendor pages.

**Two provenances, on purpose.** The single-vendor tables stay hand-maintained,
because a vendor page carries what a catalog flattens: promo windows, prompt-size
tiers, cache-write multipliers. The union tables are generated, because breadth and
name-alignment matter more there than those details.

## Still unpriced, each for a reason

- **Copilot** — bills premium requests against a seat allowance, not tokens. The
  admin page now says so on the row rather than implying a rate is missing.
- **`-latest` alias tags** (`gemini-flash-latest`, `gemini-flash-lite-latest`) — an
  alias is repointed at a new model without its name changing, so a pinned rate
  would silently misprice from the day it moves. `$0` that reports itself is the
  honest failure.
- **`gemini-3-pro-preview`** — shut down by Google and absent from both the pricing
  page and the catalog. It cannot appear in new traffic. (P12-011 called it
  "selectable in Gemini CLI"; that came from a third-party docs mirror that had not
  caught up.)
- **Locally served models** (Ollama, LM Studio, llama.cpp) — `$0` is their real
  per-token cost, so the number is already right; only the "unpriced" label is
  misleading, and the table `_comment` says so.
- **Providers models.dev does not carry.** Still `$0`, still counted in
  `unknown_model_events_total`.

## Fixtures naming models nobody ships

Auditing the `gemini-3-pro-preview` question turned up the same problem in the
test suite: three adapter fixtures named models no vendor has ever shipped —
`gemini-3-pro` (it was `gemini-3-pro-preview`, now shut down), `gpt-5.2-codex`
(OpenAI's line goes `gpt-5-codex` → `gpt-5.3-codex`), and a bare `claude-opus-4`
(Opus 4 only ever had a dated id). All three were green, on input that bills `$0`
in production — the same shape as P12-002, where opencode's fixtures used
UUID-shaped session ids while the real ones were `ses_`-prefixed.

Replaced with ids taken from the shipped tables, and the "test with realistic
payloads" rule in [`apps/hook/AGENTS.md`](../apps/hook/AGENTS.md) now says model
names count. It cannot be enforced by a test: the price tables live in
`apps/ingest` and `apps/hook` must not depend on it.

The `unknown_model_surge` alert fixture moved off `gemini-3-pro-preview` too — a
shut-down model cannot be the unpriced model an operator is being warned about.
It now shows the two shapes that really occur: an alias tag and a provider the
tables do not cover.

## Files touched

- `scripts/gen-price-tables.ts` (new), `package.json` (`gen:price-tables`)
- `apps/ingest/src/data/price-table.{pi,omp,opencode}.v1.json` (generated),
  `price-table.gemini_cli.v1.json` (hand edit)
- `apps/ingest/test/price-tables.test.ts` — invariants split by provenance, plus
  the cross-source agreement test
- `apps/web/src/app/admin/price-tables/page.tsx`
- `apps/hook/src/adapters/{gemini-cli,omp,stdin-hook-factory}.test.ts`,
  `apps/ingest/test/alert-notify.test.ts` — fixtures onto real, priced model ids
- `apps/ingest/AGENTS.md`, `apps/hook/AGENTS.md`, `DESIGN_DOC.md` §11.6

## Out of scope

- A request-denominated cost model for Copilot (`PriceTableSchema` is per-mtok).
- Prompt-size tiering — the catalog carries `tiers`, this schema holds one rate.
- Scheduling the regeneration. It is a human-reviewed diff on purpose: the review
  gate is the PR, not the script.

## Verification

```bash
bun run gen:price-tables            # or --from ./api.json
bun run check && bun run typecheck && bun run build && bun run test
```
