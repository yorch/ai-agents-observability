---
id: P10-005
title: Model governance enforcement
phase: 10
workstream: C
status: done
owner: claude
depends_on: [P10-002, P9-001]
blocks: []
estimate: M
---

## Goal

Turn the allowed-model policy (`P10-002`) into something enforceable: a scheduled
alert when sessions run under a disallowed model, wired into the Phase 9 engine and
carrying no individual-identifying data, plus an optional hook-side pre-flight warning
when a developer starts a session under a non-approved model.

## Context

See [`P10-roadmap.md`](./P10-roadmap.md). Governance today is report-only: the
`unknown_model_surge` rule (`P9-001`, `apps/ingest/src/jobs/evaluate-alerts.ts`)
flags *unfamiliar* models, but there is no notion of an *org-approved set*. Once
`P10-002` defines the allowed set, the org can be alerted when spend flows to models
outside it — before the invoice.

Trust guardrails from Phase 9 are binding: alerts carry aggregate signals only (no
session ids, user handles, or transcript content), honor `silencedUntil`, and write
`AlertEvent` rows via the existing transition machinery.

## Acceptance criteria

- [x] A new `disallowed_model` alert rule type evaluates in `evaluate-alerts`:
      aggregate spend/session count under models not in the `agent_type`'s allowed set
      over the evaluation window, above a configurable threshold.
- [x] The rule reads the allowed set from the `P10-002` policy — no second definition
      of "allowed."
- [x] Firing produces an `AlertEvent` and dispatches to enabled channels
      (Slack/webhook/email) with aggregate-only detail; `silencedUntil` and
      acknowledge behavior match existing rules. Covered by the governance test suite
      style of `P9-006`.
- [x] The rule appears in `/admin/alerts` alongside existing rules (enable/disable,
      silence).
- [x] (Optional, behind a config flag) The hook prints a non-blocking warning at
      `SessionStart` when `permission`/model context indicates a non-approved model —
      it never blocks the session (enforcement-by-block is explicitly out of scope).
- [x] Alert payloads contain no `session_id`, `user_id`, `github_login`, or transcript
      text — asserted by a test.

## Implementation notes

- Add `disallowed_model` to `packages/schemas/src/alerts.ts` (`AlertRuleType`) and the
  evaluator switch in `apps/ingest/src/jobs/evaluate-alerts.ts`; reuse
  `alert-transition.ts` for open/resolve.
- Seed the rule disabled (like `budget_threshold`) since it needs a configured allowed
  set to be meaningful.
- The hook warning, if built, lives in the adapter seam's session-start path and reads
  the policy via a cached `/v1/price-table`-adjacent fetch or a new lightweight
  endpoint — do not add a hot-path network call that violates the <10ms budget; fetch
  async / cache.

## Files touched

- `packages/schemas/src/alerts.ts`
- `apps/ingest/src/jobs/evaluate-alerts.ts` (+ test)
- `packages/db/sql/migrations/000N_seed_disallowed_model_alert.sql` (new)
- `apps/web/src/app/admin/alerts/page.tsx` (surface the rule)
- (optional) `apps/hook/src/` session-start warning path

## As shipped

- `disallowed_model` joins the `AlertRuleType` union with its own window/threshold
  constants, evaluated in `evaluate-alerts` alongside the existing rules and using
  the same transition, silence, acknowledge and dispatch machinery.
- The allowed set comes from the `P10-002` `model_policy` table — there is no second
  definition of "allowed".
- **An empty or missing allow-list means unconfigured, never "deny everything."**
  Enforced twice in SQL: an INNER JOIN on `model_policy` (an agent with no row
  contributes nothing) and `COALESCE(array_length(mp.allowed_models, 1), 0) > 0`.
  The `COALESCE` is load-bearing — Postgres `array_length` returns `NULL`, not `0`,
  for an empty array, so the bare comparison would drop rows by accident rather
  than by intent. Without this, enabling the rule on a fresh install would flag
  every session in the org.
- Seeded **disabled** (`0007_seed_disallowed_model_alert.sql`), because it is inert
  until an org configures an allow-list and should not fire on upgrade.
- `details` carries numbers only — spend, counts, window, and a *count* of distinct
  disallowed models, never their names. A test poisons `details` with
  `userId`/`sessionId`/`login` and asserts none survive into the dispatched payload.
- No web change was needed for `/admin/alerts`: it renders rules generically, so
  enable/disable/silence work for the new type as soon as the seed inserts it.

## Not done

- The optional hook-side `SessionStart` warning. It was marked optional, and it is
  the only part of this task that would put policy on the developer's machine —
  worth its own decision rather than riding along here.

## Out of scope

- Hard-blocking a model at the hook (separate trust decision).
- Any individual-level "who used the bad model" surface — this stays aggregate;
  investigation goes through the Phase 9 grant path.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/ingest' test evaluate-alerts
bun run typecheck
# Manual: set an allowed set excluding a seeded model, trigger evaluate-alerts via
# POST /admin/jobs/evaluate-alerts/run, confirm an AlertEvent with aggregate-only detail.
```
