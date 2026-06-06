---
id: P3-006
title: Privacy enforcement property-test suite
phase: 3
workstream: C
status: ready
owner: null
depends_on: [P3-005]
blocks: []
estimate: M
---

## Goal

A property-based test suite using `fast-check` that generates random user/role/visibility-policy combinations and asserts that the access control layer never exposes data beyond what the policy allows.

## Context

- `DESIGN_DOC.md` §8.2 — visibility policies: `share_metadata_with_team`, `share_transcripts_with_team`.
- `PLAN.md` §3 Phase 3 exit criteria — "Privacy enforcement test suite passes with 100% of generated cases."
- The suite tests the query functions in `team-queries.ts` against a known DB state, not the HTTP layer.
- Uses `fast-check` (already in the catalog at 4.4.0).

## Acceptance criteria

- [ ] `apps/web/src/lib/__tests__/privacy.test.ts` uses `fc.assert(fc.property(...))` with ≥ 200 runs.
- [ ] Properties tested:
  - A member with `share_metadata_with_team = false` never appears with cost/session stats in the roster result.
  - A member with `share_transcripts_with_team = false` causes transcript access to return `null` / be blocked.
  - A `member`-role user cannot access the roster query (role check tested at the query level).
  - Team lead for Team A cannot retrieve sessions for a user who is only in Team B.
- [ ] Tests run in CI via `bun run test`.
- [ ] TypeScript and Biome clean.

## Files touched

- `apps/web/src/lib/__tests__/privacy.test.ts` (new)

## Out of scope

- HTTP-layer integration tests (use unit tests against the query functions).
- Org-level policy tests (Phase 4).
