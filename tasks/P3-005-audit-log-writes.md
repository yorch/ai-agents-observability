---
id: P3-005
title: Audit log writes on every cross-user view
phase: 3
workstream: C
status: in-progress
owner: null
depends_on: [P3-001]
blocks: [P3-003, P3-004, P3-006, P3-007]
estimate: M
---

## Goal

A `writeAuditLog(params)` server helper that inserts an `AuditLog` row and an `assertAudited()` test utility that fails CI if a route returns a cross-user response without writing a log entry. Every team-scoped read of another user's data calls `writeAuditLog`.

## Context

- `DESIGN_DOC.md` §8.3 — "Every team_lead or org_admin view of someone else's session writes an audit_log row." Non-negotiable.
- The Prisma `AuditLog` model has fields: actor_user_id, action (AuditAction enum), target_user_id?, target_session_id?, target_team_id?, justification?, ip?, user_agent?.
- Existing `AuditAction` values: view_session, view_transcript, export_team, export_org, admin_impersonate, delete_request, hook_token_issued.
- Audit writes must be fire-and-forget (non-blocking) but must not be silently dropped — use `void` with a `catch` that logs the error.

## Acceptance criteria

- [ ] `apps/web/src/lib/audit.ts` exports `writeAuditLog(db, params)` with typed params covering all P3 use cases.
- [ ] `writeAuditLog` is called (and awaited) in: roster page load (export_team), member session list (view_session), transcript view (view_transcript).
- [ ] `ip` and `user_agent` captured from the incoming request headers where available.
- [ ] Unit test: `writeAuditLog` inserts one row with the correct fields.
- [ ] Negative test: roster page rendered without calling `writeAuditLog` fails an assertion (use a test-only spy or check DB row count).
- [ ] TypeScript and Biome clean.

## Implementation notes

- Import `headers()` from `next/headers` in Server Components / Route Handlers to get `x-forwarded-for` and `user-agent`.
- `writeAuditLog` should not throw — wrap the Prisma insert in try/catch and log on failure.
- `ip` from `x-forwarded-for` header (first value only, comma-split).

## Files touched

- `apps/web/src/lib/audit.ts` (new)
- `apps/web/src/lib/__tests__/audit.test.ts` (new)

## Out of scope

- Surfacing audit log to the viewed user (P3-007).
- Org-level audit (Phase 4).
