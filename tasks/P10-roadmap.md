# Phase 10 — Model Cost Optimization (roadmap)

**Trigger to decompose**: [`OPPORTUNITIES.md`](../OPPORTUNITIES.md) §3.2 and §4 rank
"Model cost optimization (routing + cache-efficiency guidance)" as the single
highest impact-to-effort opportunity — potential 30–50% spend reduction, low
effort, data already captured. The platform records **per-turn `model`** (not just
a per-session primary), `tool_category`, `shape_label`, and cache-token
breakdowns, but only surfaces a single org-level heuristic card.

**Current state (what exists):** `/org/models` (`apps/web/src/app/org/models/page.tsx`)
already renders a "routing opportunities" section and an org cache-efficiency stat.
It is a **first-pass heuristic**, not a defensible optimization surface:

- A flat `DOWNGRADE_SAVINGS_RATE = 0.8` constant stands in for the real
  premium→standard price ratio.
- `PREMIUM_PATTERNS = ['opus']`, `CHEAP_CATEGORIES = {fs_read, search, web}`, and the
  economy/standard tiers are hardcoded in the page component — not derived from the
  per-agent price tables (`P8-002`) and not configurable.
- It is org-only. Team leads and individual developers — the personas who can
  actually change their behavior — get no routing guidance.
- Savings are presented as point estimates with no volume/confidence gating and no
  outcome caveat, which `DESIGN_DOC.md` §10.6 warns against ("precisely misleading
  without outcome context").
- Model governance is report-only. `unknown_model_surge` alerts exist (`P9-001`) but
  there is no *allowed-model policy* the org can enforce.

**Goal recap:** move from "here is a rough org number" to "here is a defensible,
per-task, per-persona recommendation you can act on, and a policy the org can
enforce" — without violating the trust model or shipping a vanity metric.

Turn the heuristic into a first-class capability:

1. A **defensible savings model** derived from the actual per-agent price tables,
   segmented by task type (`tool_category`) and session shape, expressed as ranges
   with volume/confidence gating — never a single seductive point estimate.
2. A **shared, configurable model policy** (tiers, allowed models, cheap-work
   categories) that both the dashboards and the governance engine read from one
   source, per `agent_type`.
3. **Persona-appropriate guidance**: org (portfolio + team breakdown), team lead
   (team routing + cache coaching), individual dev (individual-value-first tips on
   `/me/insights`, reusing the friction-coaching pattern).
4. **Governance enforcement**: an allowed-model policy wired to the Phase 9 alert
   engine, with an optional hook-side pre-flight warning.
5. A **validation loop** that compares projected vs realized savings after a team
   adopts a change, so the recommendation surface stays honest.

See `DESIGN_DOC.md` §10.5 (metrics to avoid — do not regress into LOC/vanity
framing), §10.6 (effectiveness caveat), `OPPORTUNITIES.md` §3.2 and §5 (the
"aggregate-first, individual-second" and "what does the individual get" rules).

## Sketched tasks

- **P10-001 Routing analysis query layer + defensible savings model**
  A tested query/derivation layer that aggregates cost and tokens by
  `(agent_type, model, tool_category, shape_label)` and computes savings **ranges**
  from real price-table ratios (premium→standard→economy per agent), replacing the
  flat `0.8` constant. Volume-gated (suppress low-n). Foundation for all P10 UI.

- **P10-002 Shared, configurable model policy**
  Move tier classification, allowed-model lists, and cheap-work categories out of the
  page component into one per-agent policy source (a `model_policy` table +
  `/admin/model-policy` admin UI, seeded from price-table tiers). Both the dashboards
  (P10-003/004) and the governance engine (P10-005) read from it.

- **P10-003 Org model optimization dashboard**
  Replace the single heuristic card on `/org/models` with a recommendations surface:
  savings by task type and by team, ranges with confidence/volume gating, cache-
  efficiency opportunities, and the mandatory effectiveness caveat. Consumes
  P10-001/002.

- **P10-004 Team + individual routing guidance**
  Routing + cache-efficiency coaching on `/team/[slug]` and `/me/insights`,
  reusing the `buildRecommendations()` pattern. Individual-value-first, visibility-
  policy-aware. No individual routing data leaks to aggregate viewers.

- **P10-005 Model governance enforcement**
  Turn the model policy into an enforceable allowed-model list: a new
  `disallowed_model` alert rule wired to the Phase 9 engine (aggregate-only, no
  identifying data), plus an optional hook-side pre-flight warning when a session
  starts under a non-approved model. Depends on P10-002, P9-001.

- **P10-006 Recommendation validation loop**
  Cohort before/after comparison of projected vs realized spend when a team adopts a
  routing change, surfaced as a "did it work?" panel. Keeps the recommendation
  surface honest and closes the loop on the effectiveness caveat.

## Exit criteria

- An org admin sees, on `/org/models`, routing recommendations segmented by task
  type and team, with savings expressed as **ranges** derived from the live per-agent
  price tables (no hardcoded `0.8`), suppressed where volume is too low to be
  credible, and each paired with the outcome caveat.
- A team lead sees team-level routing + cache-efficiency guidance on `/team/[slug]`;
  an individual dev sees at least one actionable, individual-value-first routing or
  cache tip on `/me/insights` when their own data warrants it — and none when it
  doesn't.
- Tier/allowed-model/cheap-category definitions live in exactly one place
  (`model_policy`), are editable by an org admin without a redeploy, and are read by
  both the dashboards and the alert engine.
- An org admin can define an allowed-model set; a session under a disallowed model
  raises an aggregate alert within one evaluation cycle, carrying no individual
  identifiers, honoring `silencedUntil`.
- After a team adopts a routing change, the validation panel reports projected vs
  realized spend delta for the following period.
- No new surface presents a bare cost-savings number without the §10.6 outcome
  caveat, and no P10 metric regresses into a §10.5 vanity metric.

## Out of scope

- **Automated / enforced model switching.** This phase *recommends* and *alerts*; it
  never silently reroutes a developer's model. Enforcement beyond an alert (e.g.
  hard-blocking a model at the hook) is a separate decision with its own trust review.
- **External billing reconciliation.** Savings use client-computed cost from the
  price tables; reconciliation against a vendor invoice remains the gated
  `reconcile-cost` seam (`P8-006`).
- **Per-turn model *auto-routing* inside the agent.** We observe and advise; we do
  not build a router.
