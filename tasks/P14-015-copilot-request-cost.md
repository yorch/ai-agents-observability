---
id: P14-015
title: Request-denominated cost dimension, and Copilot pricing
phase: 14
workstream: A
status: review
owner: claude
depends_on: [P14-007]
blocks: []
estimate: M
---

## Goal

Give the price table a second denominator so an agent billed per *request*
rather than per token can be priced honestly, and make Copilot's spend stop
reading `$0`.

## What the research changed

The task was scoped from a finding recorded on 2026-08-18 and repeated in
`price-table.copilot.v1.json`, `DESIGN_DOC.md` §11.6 and `apps/ingest/AGENTS.md`:

> Copilot does not bill tokens at all. A seat carries a monthly premium-request
> allowance … Pricing Copilot honestly needs a request-denominated cost model
> this schema cannot express.

**That stopped being true on 2026-06-01.** Checked directly against GitHub's own
documentation on 2026-08-27, twice and independently:

- Copilot now bills **tokens**, metered as *AI credits* (1 credit = $0.01 USD),
  with a published per-model USD-per-million-token rate.
  ([models-and-pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing))
- Request-based billing survives only for "Copilot Pro and Copilot Pro+
  subscribers on an existing annual plan who remained on legacy premium
  request-based billing after June 1, 2026".
  ([copilot-requests (legacy)](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests))
- Copilot CLI *is* billed (code completions and next edit suggestions are not).
- The published multiplier table is frozen at the June cutover: it lists no
  Opus 5, Sonnet 5, Fable 5, Grok or Kimi, all of which the token table prices.
  ([model-multipliers-for-annual-plans](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/model-multipliers-for-annual-plans))

So the premise inverted: **capturing tokens *would* fix Copilot's cost.** The
schema was never the blocker for the mainstream case; the empty price table and
the capture gap were, and only one of those is fixed here.

## Billing figures, as shipped

Retrieved 2026-08-27, both pages fetched twice by independent readers with
identical results.

| | |
|---|---|
| Current denominator | tokens → AI credits, 1 credit = $0.01 USD |
| Models priced | 32, across OpenAI / Anthropic / Google / Microsoft / xAI / Moonshot / GitHub |
| Legacy denominator | premium requests, annual Pro/Pro+ holdovers only |
| Legacy allowance | Pro 300/month, Pro+ 1,500/month per seat |
| Legacy overage | $0.04 per premium request |
| Legacy multipliers | 24 models, **0.25× to 57×** |

Recorded but not modelled: the `(Long context)` rate tier for several models
(DESIGN_DOC §11.6 is one-rate-per-model, so only the Default tier is stored);
Copilot code review at 13×; the documented 10% discount for auto model
selection; and BYOK, which GitHub's docs do not say whether it consumes credits.

## The event→request mapping, and why no dollar figure comes off it

GitHub is unusually precise here, and the mapping is **exact**:

> "Each prompt to Copilot CLI uses one premium request with the default model.
> For other models, this is multiplied by the model's rate."

> "For agentic features, only the prompts you send count as premium requests;
> actions Copilot takes autonomously to complete your task, such as tool calls,
> do not."

One prompt is one request, and a whole agentic tool loop inside it is still one.
Our `UserPromptSubmit` event *is* that prompt, and it is already accumulated per
session as `sessions.user_message_count`. **Confidence: high** — this is not an
inference, it is the documented unit.

**The multiplier is what is undetermined, and it is fatal to a dollar figure.**
No Copilot CLI hook payload carries a model — re-verified field-by-field across
all thirteen documented events on 2026-08-27, confirming P14-007. The published
multipliers span 0.25× to 57×, a 228× spread, and **no model in GitHub's table
has a multiplier of 1**, so "one prompt is one premium request" cannot be turned
into dollars by defaulting either. The CLI's default model is not named in the
docs. A count is exact; a cost is not, so none is computed.

Per the task's own instruction, the claim is scoped to what the data supports: a
prompt count, and a dash where a dollar figure would be.

## What changed

**`packages/schemas/src/price-table.ts`** — optional `request_pricing`
(`multipliers`, `overage_usd_per_request`, `included_requests_per_seat_month`)
plus `isRequestPriced()` and `requestCostUsd()`. Optional and additive: every
shipped table validates unchanged, `computeCostUsd` does not read it, and a
request-priced table needs no token rates. `requestCostUsd` returns `undefined`,
not `0`, for an unlisted model — a multiplier of `0` is a real value (an
included model, genuinely free) and an unknown model must not render as free.

**`apps/ingest/src/data/price-table.copilot.v2.json`** — 32 models at GitHub's
published rates, plus `request_pricing` for the legacy cohort. `copilot.v1` is
deleted rather than retained: the convention keeps old versions so history stays
reproducible, and v1 priced every event at exactly `$0` through an empty map, so
there is provably nothing to reproduce.

**Ingest is otherwise untouched.** Copilot now prices through the existing
`computeCostUsd` with no code change, which is also why a token-priced agent's
cost is provably unaffected. Request pricing is deliberately *not* wired into
the cost path: which denominator a seat bills on is a property of its **plan**,
which no event carries, so ingest choosing one would be a guess — and for a
monthly-plan seat it would be the wrong guess.

**`apps/web`** — `/org/agents` reports cost as `null` (rendered `—`, with a
footnote) for an agent that reported no tokens *and* no cost across the window,
because cost is derived from tokens and a zero with no tokens behind it is the
absence of a measurement, not a measurement of zero. Keyed on the data, never on
an agent name. A `Prompts` column comes with it, from the existing
`user_message_count`. `/admin/price-tables` renders the request dimension as
reference, with copy stating it is a marginal rate past an allowance.

## Imputed vs billed — how it is labelled

Nothing in the product prints an imputed dollar figure, which is the strongest
possible version of "the UI must not let a reader mistake imputed for billed".
The two places request pricing is visible say so in prose:

- the schema and the table's `_comment` state that any figure off it is imputed
  marginal cost at the overage rate, not billed spend;
- `/admin/price-tables` says the per-request rate applies only past the
  allowance, and that neither the seat's plan nor its remaining allowance is
  observable from telemetry.

Allowance consumption (`180 / 300`) is deliberately **not** shown against a
figure. The numerator would be prompts × an unknown multiplier and the
denominator depends on a plan we do not know, so the fraction would be wrong in
both halves.

## `unpriced-models` interaction

Copilot models were **never** counted as unpriced, contrary to what
`DESIGN_DOC.md` §11.6 and the v1 `_comment` both claimed. Both
`unknown_model_events_total` (via `computeCostUsd`, called only when an event
has an `llm` block) and `getUnpricedModels` (`WHERE model IS NOT NULL`) key on a
model, and no Copilot event has ever carried one. That claim is corrected in
this task rather than left standing.

Nothing changes for the alert now: Copilot still emits no model, so it still
contributes nothing. If capture lands, its models will price against the new
table instead of surfacing as unpriced — which is the intended outcome.

## No schema or migration change

None was needed, and none was added. `events.cost_usd` plus the agent's price
table is enough: which denominator priced a row is derivable at read time from
`(agent_type, model)`, and the prompt count was already on
`sessions.user_message_count`. `packages/db/sql/migrations/0001_init.sql` is
untouched, and no `0002_*.sql` was written.

## Acceptance criteria

- [x] Current billing model researched against GitHub's own docs, not memory —
      and the task's stated premise found to be superseded, and said so.
- [x] Price-table schema expresses request pricing; token tables unaffected.
- [x] Every existing agent table still validates.
- [x] Event→request mapping decided, sourced, and its uncertainty stated.
- [x] No imputed figure presented as billed spend — none is presented at all.
- [x] Copilot's `$0` replaced with an honest unknown plus a prompt count.
- [x] `unpriced-models` interaction checked and the stale claim corrected.
- [x] No migration; justified above.
- [x] Four gates green before each of the four commits.

## Out of scope

- **Copilot usage capture.** The remaining blocker, and P14-007's territory: no
  hook payload carries tokens *or* a model. A hook could *infer* a model from
  `COPILOT_MODEL` / `~/.copilot/settings.json`, but that misses a custom agent
  definition above it and the unnamed default below it, so it is an inference,
  not a measurement — noted in `copilot.ts` for whoever attempts it.
- **The GitHub billing REST API** (`/users|organizations/{…}/settings/billing/
  ai_credit/usage`) — real ground truth for consumption, and the right way to
  reconcile Copilot spend the way `reconcile-cost` does for Anthropic. A
  separate task; it needs credentials and a scheduled job, not a price table.
- Cost surfaces other than `/org/agents` and `/admin/price-tables`. `$0` still
  shows for Copilot on the dashboard, session and My Agents views; threading a
  nullable cost through every one of them is a larger change than this task, and
  `/org/agents` is where cross-agent comparison actually happens.
- Repricing history. `reprice-events` would now find Copilot models priced, but
  there are none stored, so there is nothing to reprice.

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test   # green
```

## What could not be verified here

- **Anything needing a live database or Docker.** A sibling task held exclusive
  database access for the duration. Unrun, and needing one: the
  `getAgentTypeComparison` SQL (`SUM(s.user_message_count)` against
  `interactive_sessions`) is exercised only against a mocked client here, and
  `/org/agents` and `/admin/price-tables` were not loaded in a browser.
- **The price-table keys.** No Copilot event has ever carried a model, so
  nothing has exercised them. They are GitHub's published display names,
  lowercased and hyphenated — a transform that reproduces the two slugs GitHub
  documents for `COPILOT_MODEL` (`claude-haiku-4.5`, `claude-sonnet-4.5`), but
  the other 30 are unverified and flagged as such in the file's `_comment`.
- **A live Copilot CLI session.** Everything about Copilot's behaviour here is
  from GitHub's current documentation, not observed against a running CLI.
