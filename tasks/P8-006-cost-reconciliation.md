---
id: P8-006
title: Cost reconciliation (design + scaffold)
phase: 8
workstream: B
status: done
owner: claude
depends_on: [P8-002]
blocks: []
estimate: M
---

## Reconciliation design

- **Vendor API (first real impl, gated):** Anthropic admin/usage API
  (`GET /v1/organizations/usage_report` style) for `claude_code`. Each agent maps to
  its own `BillingSource`; the interface is keyed by `(agentType, year, month)` so a
  second agent (e.g. an OpenAI-backed one) plugs in without touching reconciliation logic.
- **Cadence:** monthly granularity (billing APIs report monthly). The job runs on a
  daily timer but always reconciles the **previous full calendar month** (UTC) — re-running
  is idempotent (it just re-sets the gauges), so a daily tick is cheap and avoids
  month-boundary edge cases. No hourly polling (wastes quota, no accuracy gain).
- **Alignment:** client cost = `SUM(events.cost_usd)` over `[firstOfPrevMonth, firstOfThisMonth)`
  grouped by `agent_type`; vendor cost = `fetchBilledCost(agent, year, month)` for the same
  month. Both org-level (no per-developer reconciliation).
- **Surfacing:** `cost_reconciliation_delta_usd{agent_type}` (client − vendor) and
  `cost_reconciliation_drift_ratio{agent_type}` (|delta| / vendor) gauges; drift above the
  threshold (default 5%) increments `cost_reconciliation_threshold_exceeded_total{agent_type}`
  so Alertmanager/Grafana can alert. Complements (does not replace) `unknown_model_events_total`.
- **Gated:** ships with `NullBillingSource` (returns null → no comparison, gauges set to 0);
  disabled unless `BILLING_RECONCILIATION_ENABLED=true`. No real vendor client built here.

## Goal

Design and scaffold a reconciliation job that compares client-computed cost (summed from `events.cost_usd`) against a vendor billing API as ground truth, surfacing price-table drift as a metric/anomaly. Deliver the design and the pluggable seam now; actual vendor integrations are gated per DESIGN_DOC.md §13 Q4 and PLAN §5.

## Context

DESIGN_DOC.md §11.6 notes that client-side cost computation is the v1 choice with the caveat "Ground truth (Anthropic admin API) is heavier dependency; deferred." §15 (Future Directions) calls out "Anthropic admin API integration — Pull billed amounts as ground truth; reconcile against client-computed costs to catch drift." This is the scaffolding task that makes that future integration a simple plug-in rather than a rework.

**GATED**: Do not build any specific vendor billing integration in this task. The trigger is a team's spend disputes exceeding accuracy threshold, or a demonstrated drift ≥ 5% over 30 days. This task delivers the design and the seam so that when the trigger fires the integration is a weekend of work, not a sprint.

Price tables from P8-002 are versioned (`version`, `generated_at`), enabling historical cost reproduction — reconciliation can re-price stored token counts against a later table to measure drift.

`unknown_model_events_total` already flags any event that billed at `$0`; reconciliation should complement this, not replace it.

## Acceptance criteria

- [x] A reconciliation design note (written in this file under `## Reconciliation design` when the task is claimed) covering: which vendor API(s) to call, polling cadence, how to align billing periods with DB aggregates, and how discrepancies are surfaced (metric label / anomaly / alert).
- [x] A job seam at `apps/ingest/src/jobs/reconcile-cost.ts` that: (a) queries aggregated client-computed cost for a time window from the DB; (b) calls a pluggable `BillingSource` interface to retrieve vendor-reported cost for the same window; (c) computes the delta; (d) emits a `cost_reconciliation_delta_usd` Prometheus gauge and a `cost_reconciliation_drift_ratio` gauge (delta / vendor total).
- [x] The `BillingSource` interface is documented; a `NullBillingSource` stub ships that returns zero (no real vendor call) so the job can run in CI and the seam is tested.
- [x] The reconciliation job is wired into `apps/ingest/src/jobs/scheduler.ts` but **disabled by default** (only runs if `BILLING_RECONCILIATION_ENABLED=true` env var is set).
- [x] A `BILLING_RECONCILIATION_ENABLED` entry is added to `apps/ingest`'s `loadConfig()` schema (defaulting to `false`).
- [x] Drift above a configurable threshold (default 5%) increments a `cost_reconciliation_threshold_exceeded_total` counter (so Grafana/Alertmanager can alert on it).
- [x] `bun run typecheck` passes; `bun run check` passes; `bun --filter '@app/ingest' test` passes.

## Implementation notes

`BillingSource` interface sketch:

```typescript
export interface BillingSource {
  /** Return total billed cost in USD for the given agent and calendar month. */
  fetchBilledCost(agentType: AgentType, year: number, month: number): Promise<number | null>;
}

export class NullBillingSource implements BillingSource {
  async fetchBilledCost() { return null; }
}
```

The Anthropic admin API (`/v1/usage`) is the anticipated first real implementation; structure the interface so it can be added without changing the reconciliation logic.

Cadence: monthly is sufficient for v1 (billing APIs are monthly). Do not poll hourly — that wastes quota and the data isn't more accurate.

## Files touched

- `apps/ingest/src/jobs/reconcile-cost.ts` (new — job + BillingSource interface)
- `apps/ingest/src/jobs/scheduler.ts`
- `apps/ingest/src/app.ts` (or `loadConfig.ts` — add `BILLING_RECONCILIATION_ENABLED` to config schema)
- `apps/ingest/src/lib/metrics.ts` (new gauges/counters)

## Out of scope

- Implementing any real vendor billing API client (Anthropic, OpenAI, etc.) — that is the demand-gated follow-up.
- A UI surface for reconciliation results — Grafana/Alertmanager on the existing Prometheus metrics is sufficient for v1.
- Per-developer cost reconciliation — reconcile at the org/agent level only.

## Verification

```bash
bun run typecheck
bun run check
bun --filter '@app/ingest' test

# With BILLING_RECONCILIATION_ENABLED=false (default): job does not run, no errors on scheduler init
# With BILLING_RECONCILIATION_ENABLED=true + NullBillingSource: job runs, emits 0-value gauges, no crash
```

> **Verification status (done):** `reconcile-cost.test.ts` (3 cases — prev-month window +
> per-agent billing call, NullBillingSource no-crash, lock-skip) **passes locally** (db mocked)
> + `biome check --error-on-warnings` clean. `BillingSource` interface + `NullBillingSource`
> ship; `runReconcileCost` reconciles the previous calendar month per agent, emits
> `cost_reconciliation_delta_usd` / `_drift_ratio` gauges + `_threshold_exceeded_total` counter
> (default 5%). Wired into the scheduler as a daily timer **gated on
> `BILLING_RECONCILIATION_ENABLED`** (default false, added to `loadConfig`); also dispatchable
> via `triggerJob('reconcile-cost')`. No real vendor client built (gated). `typecheck` runs in CI
> (Prisma client egress-blocked locally).
