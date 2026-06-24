---
id: P9-003
title: Time-boxed access grants (request/approve workflow)
phase: 9
workstream: C
status: ready
owner: null
depends_on: [P3-005]
blocks: [P9-005]
estimate: L
---

## Goal

Build the request/approve workflow for time-boxed transcript access described
in `DESIGN_DOC.md §8.4`. Replaces implicit standing org-admin transcript reach
with an explicit, scoped, expiring grant that the viewed user can see.

## Context

- `DESIGN_DOC.md §8.4`: "an org admin can request transcript access for a
  specific session by providing a justification… logged loudly and visibly. The
  user sees the access in their own audit feed." The audit `AuditAction` entries
  (`view_transcript`, `admin_impersonate`) exist (P3-005), but the request/approve
  step that should gate them does not.
- Today `canViewIndividuals` (org_admin check in `apps/web/src/lib/roles.ts`)
  grants standing reach to all transcripts. This task changes that: transcript
  access for users with `share_transcripts_with_org=false` must be gated by an
  active, non-expired `access_grants` row.
- `P3-005` established `writeAuditLog` and the `AuditAction` enum. This task
  extends both.

## Acceptance criteria

- [ ] Migration adds `access_grants` table: id, grantee_user_id FK, target_user_id
      FK nullable, target_session_id UUID nullable, scope (enum: `user_sessions`,
      `single_session`), justification TEXT NOT NULL, granted_by_user_id FK,
      requested_at, granted_at nullable, expires_at nullable, revoked_at nullable.
- [ ] A requester (org_admin or a user with the research capability from P9-005)
      can submit a grant request with justification and scope via a UI form at
      `/admin/access-grants/new`; the pending request is visible to org_admins
      at `/admin/access-grants`.
- [ ] An org_admin can approve a pending request, setting `granted_at` and
      `expires_at` (required — no indefinite grants).
- [ ] Transcript and session access checks in `apps/web/src/lib/roles.ts`
      consult `access_grants`: access is permitted only if there exists a row
      where `grantee_user_id = currentUser`, `granted_at IS NOT NULL`,
      `expires_at > now()`, `revoked_at IS NULL`, and the scope covers the
      requested target.
- [ ] `AuditAction` enum is extended with `grant_requested`, `grant_approved`,
      `grant_revoked`; existing actions unchanged.
- [ ] `writeAuditLog` is called on: grant request (actor=requester,
      target_user_id=target), grant approval (actor=approver), every transcript
      view made under a grant (actor=grantee, target=session).
- [ ] The viewed user sees all of the above audit rows in `/me/audit` — the
      `target_user_id` index already enables this.
- [ ] An expired grant (`expires_at < now()`) is treated identically to a missing
      grant — no access, no special error message that confirms whether a grant
      existed.
- [ ] An org_admin can revoke an active grant at `/admin/access-grants`; sets
      `revoked_at`; audited.
- [ ] TypeScript and Biome clean.

## Implementation notes

- The access check helper should be a single function:
  `hasActiveGrant(db, { granteeId, targetUserId?, targetSessionId? }): Promise<boolean>`.
  Call it from every transcript/session route that previously relied on
  `canViewIndividuals` alone.
- `expires_at` should default to 48 h when the approver doesn't specify; surface
  the default in the UI.
- Keep the grant request form simple: justification (free text, required),
  target scope (single session UUID or all sessions for a user), no elaborate
  multi-step wizard. The audit trail is the protection, not UI friction.
- Do not block org_admin access to session *metadata* (cost, tool counts,
  duration) — that already flows through `visibility_policies.share_metadata_with_org`.
  Grants gate transcript content and full session detail only.

## Files touched

- `packages/db/prisma/schema.prisma` (AccessGrant model, extend AuditAction enum)
- `packages/db/sql/migrations/` (new migration)
- `apps/web/src/lib/roles.ts` (`hasActiveGrant` helper, update transcript access checks)
- `apps/web/src/lib/audit.ts` (extend AuditAction, add audit calls)
- `apps/web/src/app/admin/access-grants/page.tsx` (new)
- `apps/web/src/app/admin/access-grants/new/page.tsx` (new)
- `apps/web/src/app/admin/access-grants/actions.ts` (new Server Actions)
- `apps/web/src/app/me/audit/page.tsx` (no structural change; new action types
  appear automatically via the existing query)

## Out of scope

- Grant requests by non-org-admin users (P9-005 adds the research capability
  that can initiate requests).
- Bulk grant for entire teams.
- Grant expiry notifications (nice-to-have; file a follow-up).
- Replacing the `visibility_policies` booleans — those remain the user-controlled
  default; grants are the override path for privileged access.

## Verification

```bash
bun run typecheck
bun run check
bun --filter '@ai-agents-observability/web' test
# Negative: access a transcript with share_transcripts_with_org=false and no
# active grant → 403 / notFound().
# Positive: insert a valid access_grants row, verify access succeeds.
# Expiry: backdate expires_at, verify access is denied.
```
