---
id: P14-017
title: Reconcile Copilot spend against GitHub's billing API
phase: 14
workstream: A
status: done
owner: claude
depends_on: [P14-015]
blocks: []
estimate: M
---

## Goal

Our Copilot cost is computed from a price table we transcribed. GitHub publishes
the actual figure. `reconcile-cost` already exists to compare our computed spend
against a vendor's own numbers and record drift — wired for Anthropic, stubbed
with `NullBillingSource` otherwise. Implement GitHub as a second `BillingSource`.

## The API, as researched

Established against GitHub's current REST reference, not memory. **Retrieved
2026-08-27.** The 2026-06-01 cutover from premium requests to token-metered AI
credits makes anything older suspect, so only GitHub's own current pages were
relied on.

| | |
|---|---|
| Endpoints | `GET /organizations/{org}/settings/billing/ai_credit/usage`<br>`GET /enterprises/{enterprise}/settings/billing/ai_credit/usage`<br>`GET /users/{username}/settings/billing/ai_credit/usage` |
| API version header | `X-GitHub-Api-Version: 2026-03-10` |
| Auth | **Classic PAT only** — "The billing usage endpoints do not support fine-grained personal access tokens." Org owner / billing manager for the org scope; enterprise admin or billing manager for the enterprise scope, which is also the only one documented to accept a GitHub App token ("read access to enterprise billing"); account holder for the user scope |
| Period granularity | `year` / `month` / `day` query params. **Omitting `day` returns the whole calendar month** — exactly `reconcile-cost`'s window |
| Other filters | `user`, `model`, `product`; enterprise adds `organization` and `cost_center_id` |
| Response | `{ timePeriod, <scope echo>, usageItems: [{ product, sku, model, unitType, pricePerUnit, grossQuantity, grossAmount, discountQuantity, discountAmount, netQuantity, netAmount }] }` |
| Pagination | **Not documented as paginated.** No `page` / `per_page`, no `has_more`. No pagination loop was invented for it |
| Retention | Past 24 months only. Reconciliation reads the previous month, so this never binds |
| Rate limits | Not stated for these endpoints specifically; standard REST limits apply |
| Denominator | Token-metered **AI credits**, 1 credit = $0.01 USD, since 2026-06-01 |

Sources, all retrieved 2026-08-27:

- [REST: billing usage](https://docs.github.com/en/rest/billing/usage) — the three
  endpoints, query params, response schema, 24-month retention.
- [REST: billing usage (Enterprise Cloud)](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage)
  — the enterprise variant, `cost_center_id`, the GitHub App permission.
- [Automating usage reporting with the REST API](https://docs.github.com/en/billing/tutorials/automate-usage-reporting)
  — classic-PAT-only, and what `quantity` / `netAmount` / `discountAmount` mean.
- [Usage-based billing for organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises)
  — 1 credit = $0.01; credits consumed by input, output and cached tokens; code
  completions and next-edit-suggestions are **not** metered; included pools of
  1,900 credits/user/month (Business) and 3,900 (Enterprise).

## Which cohort the API reports

**The token-billed one.** `ai_credit` is the post-2026-06-01 denominator, and it
is the one our `copilot.v2` price table is transcribed in. The legacy
request-billed cohort — Pro / Pro+ subscribers on an existing annual plan who did
not move on June 1 — is reported by a *separate* sibling endpoint,
`…/settings/billing/premium_request/usage`. This source reads `ai_credit` only.
Mixing them would add requests to dollars, and an account on the legacy plan
simply reports no AI-credit usage here.

## Attribution — what the data supports, and what it does not

**Org-level drift. Not per-user, not per-session.**

The response is a *single aggregate for the period*. `user`, `model` and
`product` are request **filters** that are echoed back in the response envelope;
there is no per-user array to join our sessions onto. Per-user reconciliation
would mean one request per user per month plus a GitHub-login↔user join, and it
would still be wrong: the account's bill covers every seat, including developers
who never installed our hook.

So the source returns one figure per `(agentType, month)`, `reconcile-cost`
compares it against the matching org-wide `SUM(events.cost_usd)`, and the claim
stops there.

Two further over-counts, both by construction and both documented in the source:

1. AI credits meter *every* GitHub AI product — Copilot Chat, Copilot CLI, the
   cloud agent, Copilot Spaces, Spark, third-party coding agents. Our `COPILOT`
   events come from the CLI alone. `GITHUB_BILLING_PRODUCT` narrows it; the docs
   do not enumerate the accepted values, so every run logs the distinct
   `product` / `sku` values it saw for an operator to read off a real response.
2. Seats without our hook still appear on the bill.

## `grossAmount`, not `netAmount`

`netAmount` is what GitHub invoices *after* the pooled included allowance is
discounted. `grossAmount` is the list value of the metered usage.

Our price tables are transcribed from GitHub's **published per-model rates**, so
a client-computed figure is a list-price estimate, and only `grossAmount` is the
like-for-like comparand. Reconciling against `netAmount` would report ~100% drift
for any account still inside its included pool and label it a pricing error.
Both are logged, so an operator who wants the invoice figure has it.

## What a drift figure means for Copilot *today*

**It measures our capture gap, not our arithmetic.**

No Copilot hook payload carries a token count or a model (P14-007, re-verified in
P14-015). `events.cost_usd` is derived from tokens, so `SUM(cost_usd)` for
`COPILOT` is structurally `0` — there is no priced measurement that could be
wrong. Against a real GitHub bill that is 100% drift, and shipped naively it
would fire a pricing alert every month for a hook that is working as built.

`reconcile-cost` therefore now also sums token counts per agent, and when the
vendor billed while **not one stored event carried a token**, it:

- sets `cost_reconciliation_delta_usd` and `cost_reconciliation_drift_ratio` —
  the delta is real money and hiding it would be its own dishonesty;
- logs `cost.reconciliation.no_client_token_coverage` naming the figures;
- does **not** increment `cost_reconciliation_threshold_exceeded_total`, which is
  what an operator pages on.

This is keyed on the data (zero tokens captured), never on an agent name. The day
Copilot token capture lands, `COPILOT` leaves this branch by itself and its drift
starts meaning what it says.

## Reconciliation does not rewrite computed cost

It never did and still does not. `events.cost_usd` is written once at ingest;
`sessions.total_cost_usd` is *accumulated* there and never recomputed; the PR
rollups and the continuous aggregates derive from those. Correcting that
four-way chain is `reprice-events`' job, all-or-nothing and operator-triggered.
`reconcile-cost` sets gauges and writes a `job_runs` row. That is all it writes.
The invariant is now stated in the function's own docblock, so it survives the
next person who reads the job in isolation.

## What changed

**`apps/ingest/src/jobs/github-billing-source.ts`** (new) — `GitHubBillingSource`
implementing the existing `BillingSource` interface, through the shared
`createGitHubClient` Octokit wrapper (no second GitHub client). Sources and
retrieval dates cited in the header, matching the price tables' convention.
`isRateLimited` is exported for its own test — see below.

**`apps/ingest/src/jobs/reconcile-cost.ts`** — `CompositeBillingSource` (first
source that answers wins; each already returns `null` for agents it does not
bill), the token-coverage column and the no-coverage branch, and the
"records drift, never writes cost" note on the job docblock.

**`apps/ingest/src/index.ts`** — builds a list of vendor sources and composes it.
Each source is added only when its own credential is present. Empty list →
`billingSource` stays undefined → `NullBillingSource`, bit-for-bit the previous
behaviour.

**`apps/ingest/src/config.ts`** — `GITHUB_BILLING_TOKEN`, `GITHUB_BILLING_SCOPE`,
`GITHUB_BILLING_SCOPE_KIND` (default `organization`), optional
`GITHUB_BILLING_PRODUCT` and `GITHUB_BILLING_HOST`, all Zod-validated. Both the
token and the scope are required to wire the source: there is no sensible default
account, and a token alone would have to guess one. Deliberately separate from
`GITHUB_SYNC_TOKEN` — that needs `org:read`, this reads the bill.

**Agent-neutrality.** This is a *GitHub billing source*, not a Copilot special
case. The agent mapping is a `ReadonlySet` (`GITHUB_BILLED_AGENT_TYPES`), because
GitHub meters credits for third-party coding agents too; no vendor name reaches a
schema field or a user-facing string, and nothing user-facing changed at all.

## No schema or migration change

None needed, none added. The reconciliation reads `events` columns that already
exist and writes only metrics and a `job_runs` row.
`packages/db/sql/migrations/0001_init.sql` is untouched and no `0002_*.sql` was
written.

## A real bug the tests found

`@octokit/request-error` v6 dropped the top-level `.headers` (where it survives
it now carries the *request* headers). Reading rate-limit headers from there
classified every throttled month as a permissions failure. Fixed to read
`.response.headers`, and pinned.

## Acceptance criteria

- [x] API researched against GitHub's current REST reference, with retrieval
      dates cited in code; post-2026-06-01 denominator confirmed and the legacy
      cohort's separate endpoint identified and deliberately not read.
- [x] Implemented as a `BillingSource`, through the shared Octokit wrapper.
- [x] Wired only when its credential is configured; absent config leaves
      `NullBillingSource` behaviour untouched.
- [x] Config through `loadConfig()`'s Zod schema; nothing else reads `process.env`.
- [x] Attribution scoped to what the data supports (org-level), and said so.
- [x] Reconciliation records drift and does not rewrite computed cost.
- [x] Drift against a token-less agent stated plainly as a capture gap, in code
      and here, and kept out of the breach counter.
- [x] Tests: source absent, successful fetch, auth failure, rate-limited
      response, empty period, partial period — with anti-vacuity assertions.
- [x] Four gates green before each commit.

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test   # green
```

## Out of scope

- **Copilot token capture** (P14-016 / P14-007). Until it lands, Copilot's drift
  is the size of that gap. This task makes that legible rather than closing it.
- **Per-user Copilot attribution.** Not supportable from this API; see above.
- **The legacy `premium_request` cohort.** A different endpoint and a different
  denominator. Adding it would need `request_pricing` in the comparison, and the
  plan a seat bills on is not observable from telemetry (P14-015).
- **A dashboard surface for drift.** The gauges are on `/metrics`; nothing in the
  UI reads them, here or before.
- **`cost_center_id` scoping** on the enterprise endpoint — a real way to narrow
  the figure for orgs that use cost centres, but not needed to ship the seam.

## What could not be verified here

- **Anything needing live GitHub billing credentials.** No request was made
  against a real account, so the following are documented-but-unexercised: that
  `grossAmount` is USD rather than credits (the docs describe `netAmount` as "the
  billed cost", and `grossAmount = grossQuantity × pricePerUnit` with
  `pricePerUnit` = $0.01/credit, but this was not observed); the accepted values
  of the `product` filter and which one isolates Copilot CLI; that omitting `day`
  really returns the whole month; that the endpoint is genuinely unpaginated at
  scale; and the exact classic-PAT scope name.
- **Anything needing a live database.** No Docker or `db:*` script was run. The
  `reconcile-cost` SQL (now with the token-coverage sum) is exercised only
  against a mocked client.
- **The 429 path end-to-end.** The shared Octokit distribution bundles the retry
  and throttling plugins, so a 429 is retried for ~28 s before our code sees it.
  The exhausted-quota 403 is covered end-to-end; the classifier covers the rest.
