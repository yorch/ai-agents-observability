---
id: P9-006
title: Governance + alerting invariant test suite
phase: 9
workstream: F
status: in-progress
owner: claude
depends_on: [P9-002, P9-005]
blocks: []
estimate: M
---

## Goal

A property/integration test suite proving the governance and alerting invariants
introduced in Phase 9. CI catches regressions before they become trust failures.

## Context

- `P3-006` established the privacy enforcement test pattern for Phase 3
  (property tests: random user/role + visibility policy combinations; assert
  exposure matches policy). This task applies the same discipline to Phase 9
  additions.
- `P9-001`/`P9-002` add alert evaluation and notification delivery.
  `P9-003`/`P9-005` add access grants and the investigator capability.
  `P9-004` adds per-team retention overrides.
- The trust guardrail from the roadmap is the non-negotiable property to test:
  expired/revoked grants deny access; alerts never carry individual-identifying
  content; research-role access outside a grant is denied; firing is idempotent;
  retention overrides are bounded.

## Acceptance criteria

- [ ] **Grant expiry invariant**: for any `access_grants` row with `expires_at <
      now()` or `revoked_at IS NOT NULL`, `hasActiveGrant()` returns false and
      the transcript/session route returns 403 or `notFound()`. Tested with
      property-style inputs (various expiry deltas, null vs set revoked_at).
- [ ] **No-grant denial**: an `investigator` user with zero active grants cannot
      access any individual session or transcript — asserted across at least 5
      distinct session/user combinations.
- [ ] **Alert payload sanitization**: the notify channel `send()` function, given
      an `AlertPayload` constructed from a real `alert_events` row, produces
      output that contains no user ID, github login, session UUID, or transcript
      content — verified by asserting on the serialized payload string.
- [ ] **Idempotent firing**: calling `evaluate-alerts` job logic twice in a row
      against the same firing condition inserts exactly one `alert_events` row
      (not two). Tested by running the evaluation function twice on a fixed
      dataset and asserting `COUNT(*) = 1`.
- [ ] **Idempotent resolution**: calling evaluate-alerts twice against a cleared
      condition sets `resolved_at` once; a third call does not update it again.
- [ ] **Retention override bounds**: `sweep-retention` logic with a team override
      of `retention_days > ORG_MAX_RETENTION_DAYS` uses `ORG_MAX_RETENTION_DAYS`
      as the effective limit; a team with `retention_days = null` deletes at the
      global default.
- [ ] All tests pass in CI (`bun run test` turbo task).
- [ ] TypeScript and Biome clean.

## Implementation notes

- Prefer unit/integration tests with a test database fixture over full end-to-end
  tests. The goal is fast, deterministic CI, not a browser test suite.
- The alert payload sanitization test can use a simple snapshot or `expect(payload).not.toMatch(userId)` style assertions across all fields.
- For grant tests, use the existing Prisma test client pattern established in
  `P3-006` (or equivalent) — seed rows, call the access check function directly,
  assert the result.
- Tests for `apps/ingest` (alert engine, retention) go under
  `apps/ingest/src/__tests__/`; tests for `apps/web` (access grants, research
  role) go under `apps/web/src/lib/__tests__/`.

## Files touched

- `apps/ingest/src/__tests__/evaluate-alerts.test.ts` (new)
- `apps/ingest/src/__tests__/sweep-retention-overrides.test.ts` (new)
- `apps/ingest/src/__tests__/notify-sanitization.test.ts` (new)
- `apps/web/src/lib/__tests__/access-grants.test.ts` (new)
- `apps/web/src/lib/__tests__/investigator-role.test.ts` (new)

## Out of scope

- End-to-end browser tests or Playwright coverage.
- Load / performance tests.
- Testing Phase 1–8 invariants (those are covered by existing test files).

## Verification

```bash
bun run test
# Or per-app:
bun --filter '@ai-agents-observability/ingest' test
bun --filter '@ai-agents-observability/web' test
```

> **Verification status (review):** consolidated invariant suites **pass locally** —
> `apps/ingest/test/p9-invariants.test.ts` (4: retention bounds property-loop, idempotent
> firing/resolution, payload sanitization with hostile injected ids) and
> `apps/web/test/p9-invariants.test.ts` (4: grant-expiry property-loop incl. expired==no-grant,
> empty-grant-set denial, mismatched-target denial across ≥5 combos). Investigator capability
> invariants live in `roles.test.ts` (P9-005). biome clean.
>
> **Conventions:** tests placed under the repo's existing `apps/*/test/` dirs (where vitest is
> configured) rather than the task's suggested `src/__tests__/`. Property-style coverage uses
> in-test combinatorial loops over the Prisma-free policy helpers (no new dep; runs in CI without
> a database). DB-backed end-to-end seeding is covered by the per-task tests + CI.
