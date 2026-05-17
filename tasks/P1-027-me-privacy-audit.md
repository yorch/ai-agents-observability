---
id: P1-027
title: /me/privacy + /me/audit
phase: 1
workstream: E
status: blocked
owner: null
depends_on: [P1-024, P1-003]
blocks: [P1-029]
estimate: M
---

## Goal

Two pages that materialize the trust mechanics in `DESIGN_DOC.md` §10 and §11: a privacy-settings editor backed by `VisibilityPolicy`, and a read-only audit feed of who-saw-what about the user.

## Context

- Phase 1 has no team views, so the audit feed will mostly be empty — that's correct. Shipping it now scaffolds the trust mechanic and prevents Phase 3 from sneaking in cross-user views before the audit log is wired.
- Phase 1 still writes audit events for hook token issuance and other identity-touching actions.

## Acceptance criteria

**Privacy (`/me/privacy`):**
- [ ] Form bound to `VisibilityPolicy` row for current user.
- [ ] Toggles for the four flags in `DESIGN_DOC.md` §10: `share_transcripts_with_team`, `share_costs_with_team`, `share_transcripts_with_org`, `share_costs_with_org`.
- [ ] Defaults (per §10) shown clearly with "Default" labels next to unchanged toggles.
- [ ] Save via a Server Action; success toast, persisted to DB.
- [ ] Below the toggles: explanation paragraph for each, in plain English.
- [ ] "Pause data collection" button → POSTs to `/api/me/pause-collection` which sets a server-side flag (TBD — for now, surfaces a copy-pasteable `claude-telemetry pause` command).
- [ ] "Delete my data" button → confirmation dialog → POSTs to `/api/me/delete` which queues a delete job (Phase 4 actually runs it; this task just records the request in an `AuditLog` + `DeletionRequest` table).

**Audit (`/me/audit`):**
- [ ] Read-only timeline of `AuditLog` rows where `subject_user_id == currentUser().id`.
- [ ] Columns: timestamp, actor (their display name), action, target (link if applicable), query text if any.
- [ ] Paginated, 50/page.
- [ ] Empty state for Phase 1: "No team or org views have read your data yet. When they do, you'll see it here."

## Implementation notes

- The `DeletionRequest` table is a thin queue: `(id, user_id, requested_at, processed_at nullable, reason)`. Add to Prisma in this task.
- Pause-collection: the actual pause is local (hook side, P1-023). The web UI's button is mainly informational + records intent.
- Server Actions for the form save (Next.js 15); no separate JSON API needed.

## Files touched

- `apps/web/src/app/me/privacy/page.tsx`
- `apps/web/src/app/me/audit/page.tsx`
- `apps/web/src/app/api/me/delete/route.ts`
- `apps/web/src/lib/visibility.ts`
- `apps/web/src/components/me/{PrivacyForm,AuditTable}.tsx`
- `packages/db/prisma/schema.prisma` (add `DeletionRequest`)
- `packages/db/prisma/migrations/<ts>_deletion_request/`
- `apps/web/test/privacy.test.ts`

## Out of scope

- Actually running deletion (Phase 4 GDPR / cleanup task).
- Org-level policy overrides.

## Verification

```bash
bun --filter '@app/web' test
# Manual:
# Visit /me/privacy, toggle a flag, refresh, confirm persisted.
# Visit /me/audit, confirm empty state.
```
