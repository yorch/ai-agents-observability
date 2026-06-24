---
id: P9-001
title: Alert rules engine (scheduled evaluation)
phase: 9
workstream: B
status: review
owner: claude
depends_on: [P4-004, P4-005]
blocks: [P9-002]
estimate: L
---

## Goal

Promote render-time anomaly detection into a scheduled alert-evaluation job with
persisted alert state and history. Fired and resolved transitions are recorded
once per transition — no duplicate spam.

## Context

- `P4-005` landed `getAnomalies()` in `apps/web/src/lib/org-queries.ts`: spend
  spike (>2σ vs 14-day baseline) and high tool error rate (>10% with ≥100 calls).
  The logic is correct; it just only runs at page render.
- `P4-004` landed continuous aggregates (`daily_cost_by_user`, `daily_cost_by_model`,
  `daily_tool_usage`) that provide the input data for evaluation without touching
  raw `events` rows.
- The scheduler in `apps/ingest/src/jobs/scheduler.ts` polls `job_config` every
  60 s, acquires pg advisory locks, and writes `job_runs` rows. New jobs follow
  this exact pattern (see `P4-006`, `P4-007`).
- `DESIGN_DOC.md §2.2` deferred real-time alerting as a v1 non-goal. This task
  picks it up as a scheduled cadence (not streaming), scoped to aggregate signals.

## Acceptance criteria

- [ ] Migration adds two tables: `alert_rules` (id, name, rule_type, params JSONB,
      enabled, cadence_minutes, created_at) and `alert_events` (id, rule_id FK,
      fired_at, resolved_at nullable, severity, details JSONB).
- [ ] `rule_type` supports at least: `spend_spike`, `high_error_rate`,
      `unknown_model_surge`. Optional: `budget_threshold` (per-team or per-user
      spending cap in params).
- [ ] A new job `evaluate-alerts` is registered in `job_config` and wired into
      `scheduler.ts`; it acquires a pg advisory lock before running.
- [ ] The job evaluates each enabled rule against the continuous aggregates;
      firing condition detected → inserts an `alert_events` row with
      `resolved_at = null` only if no unresolved row already exists for that rule
      (idempotent — re-evaluating a still-firing condition does not insert a
      second row).
- [ ] When a previously-fired rule's condition clears → sets `resolved_at` on the
      open `alert_events` row (transition recorded once).
- [ ] The statistical thresholds (2σ baseline window, 10% error-rate floor, 100
      call minimum) are shared constants imported from `org-queries.ts`, not
      redeclared in the job.
- [ ] Job writes a `job_runs` row on completion (consistent with existing jobs).
- [ ] TypeScript and Biome clean.

## Implementation notes

- `alert_rules` rows can be seeded with defaults in the migration (one row per
  built-in rule type, enabled=true) so the system works out of the box before
  any admin UI exists.
- The advisory lock key should be a new constant distinct from existing job keys.
- `details JSONB` on `alert_events` should carry enough context for the
  notification step (P9-002) — e.g. team name, the spike magnitude, the baseline
  — but no individual session IDs, user names, or transcript content.
- Keep the evaluation query simple: for `spend_spike`, query
  `daily_cost_by_user` aggregated to org level (or per team if `params` specifies
  a team), compare today's spend to the stddev of the prior 14-day window.
  Mirror the exact formula in `getAnomalies()`.

## Files touched

- `packages/db/prisma/schema.prisma` (AlertRule, AlertEvent models)
- `packages/db/sql/migrations/` (new migration file)
- `apps/ingest/src/jobs/evaluate-alerts.ts` (new)
- `apps/ingest/src/jobs/alert-transition.ts` (new; idempotent fired/resolved transition)
- `apps/ingest/src/jobs/scheduler.ts`
- `packages/schemas/src/alerts.ts` (new; shared threshold constants + `AlertRuleType`)
- `apps/web/src/lib/org-queries.ts` (imports the shared thresholds from
  `@ai-agents-observability/schemas` rather than defining them locally)

## Out of scope

- Notification delivery (P9-002).
- Per-user or per-team budget threshold UI (config via migration seed is enough
  for now; UI comes with P9-002).
- Streaming / real-time evaluation (scheduled cadence only).
- Alert suppression windows or escalation tiers.

## Verification

```bash
bun run typecheck
bun --filter '@ai-agents-observability/ingest' test
# Confirm job appears in job_config after migration:
# SELECT name FROM job_config WHERE name = 'evaluate-alerts';
# Confirm tables exist:
# \d alert_rules   \d alert_events
```

> **Verification status (review):** `alert-transition.test.ts` (4 cases — fire-once,
> no-double-fire, resolve-once, no-op) **passes locally** + biome clean across all touched
> files. The idempotency core (`applyAlertTransition`) was split into a Prisma-free module so
> it's testable without the generated client; the SQL evaluators + schema + migration run in CI.
>
> **Decisions:** (1) Thresholds live in `packages/schemas/src/alerts.ts` (not `org-queries.ts`)
> because `apps/ingest` cannot import from `apps/web`; `getAnomalies` now imports the same
> constants, so dashboard banners and the alert engine can't drift. (2) `evaluate-alerts` is a
> CONFIGURABLE job (job_config row seeded, default 01:00 UTC, UI-editable + manual-trigger),
> consistent with the other nightly jobs; finer-grained per-rule `cadence_minutes` is plumbed in
> the schema for a future scheduler upgrade. (3) Built-in rules are seeded in the migration so
> alerting works before any admin UI. `typecheck` + DB tests run in CI (Prisma egress-blocked).
