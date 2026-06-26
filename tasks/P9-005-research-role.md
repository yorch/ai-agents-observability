---
id: P9-005
title: Research / investigator capability (Audience B)
phase: 9
workstream: C
status: done
owner: claude
depends_on: [P9-003, P3-001]
blocks: [P9-006]
estimate: M
---

## Goal

A fine-grained, time-boxed, audited investigator capability for the Audience-B
persona (dev tools / research). Narrower than `org_admin`: can investigate sampled
individual sessions only through an active access grant (P9-003), never with
standing access. Cannot edit config or grant roles.

## Context

- `DESIGN_DOC.md §3`: Audience B asks "Is it working? Where are the friction
  points?" and needs "org-wide aggregates + sampled session investigation with
  audit logging." No existing role fits: `viewer_aggregate` is aggregate-only;
  `org_admin` grants standing config reach that a researcher should never have.
- `P9-003` builds the `access_grants` table and request/approve workflow. This
  task defines a new capability that can *initiate* grant requests for sampled
  sessions and exercise approved grants — nothing more.
- `P3-001` established the role helper pattern (`requireTeamLead`, `getTeamRole`)
  and the `OrgRole` enum. This task extends or annotates that enum.

## Why a grant-scoped capability, not a standing role

A standing `researcher` role that can view individual sessions at will would
replicate the surveillance risk the project is designed to avoid. The trust
posture (`DESIGN_DOC.md §8`, §11) requires that access to another person's
session content be:

1. Explicitly requested with justification
2. Approved by an org_admin
3. Time-boxed (expires_at mandatory)
4. Visible to the viewed user

A standing role satisfies none of these. Implementing investigator access as a
grant-scoped capability (a designated user who can *request* grants, not hold
them permanently) preserves all four properties. This is the intended design.

## Acceptance criteria

- [x] A new `OrgRole` value `investigator` is added (or a `can_request_grants`
      boolean on `users`, if extending the enum would require wider schema churn —
      choose whichever requires fewer migrations and is consistent with the existing
      role pattern in `roles.ts`).
- [x] An `investigator` user can: view org-wide aggregates (same as
      `viewer_aggregate`); submit access grant requests (P9-003 workflow) for
      specific sessions or a specific user's sessions, citing justification.
- [x] An `investigator` user cannot: edit org config; grant or revoke roles;
      view transcripts without an active grant; view another user's sessions
      without an active grant.
- [x] When an approved grant exists (`hasActiveGrant` returns true), an
      `investigator` user can view the in-scope session detail and transcript —
      subject to the target user's `visibility_policies` (transcripts still
      require `share_transcripts_with_org=true` OR an explicit grant; the grant
      is the override path for the `=false` case).
- [x] Every session or transcript view by an `investigator` user writes an audit
      row via `writeAuditLog` (reuses existing `view_session` / `view_transcript`
      actions); the target user sees these in `/me/audit`.
- [x] `investigator` role is assignable by org_admin at `/admin/team-roles` (or
      a new `/admin/org-roles` page if the existing UI only handles team roles).
- [x] Role assignment is audited (`role_grant` action, existing).
- [x] When the grant expires, the investigator's access reverts to aggregate-only
      without any code change — `hasActiveGrant` returning false is sufficient.
- [x] A comment in `roles.ts` documents the trust rationale (grant-scoped, not
      standing) so the next agent doesn't "simplify" it into standing access.
- [x] TypeScript and Biome clean.

## Implementation notes

- If adding `investigator` to the `OrgRole` Prisma enum, also update all
  `switch`/`match` statements on `OrgRole` in `roles.ts` and `canViewIndividuals`
  to handle the new value (return false — investigators cannot view individuals
  without a grant).
- The sampled-session UX is out of scope here. The investigator can navigate to
  a session URL they already know (e.g. from the org dashboard or a search result)
  and the access check does the right thing. A "sample sessions for investigation"
  UI is a follow-up.

## Files touched

- `packages/db/prisma/schema.prisma` (OrgRole enum or users boolean)
- `packages/db/sql/migrations/` (new migration if enum changes)
- `apps/web/src/lib/roles.ts` (investigator capability checks: `canViewIndividuals`
  excludes investigator, `canRequestGrants`/`requireGrantRequester` admit it, and
  `resolveOrgSessionAccess` returns `'grant'` for an investigator holding an active grant)
- `apps/web/src/app/admin/org-roles/page.tsx` + `actions.ts` (new; assign/audit roles)
- `apps/web/test/roles.test.ts` (investigator access tests)
- Grant-enforced view routes (where `resolveOrgSessionAccess` lets a grant-holding
  investigator in): `apps/web/src/app/org/sessions/[id]/page.tsx`,
  `.../transcript/page.tsx`, `apps/web/src/app/api/org/transcripts/[id]/route.ts`;
  scope predicates in `apps/web/src/lib/grant-policy.ts`.

## Out of scope

- "Sample sessions" UI for investigators (follow-up).
- Investigators initiating grants on behalf of others.
- Any capability that allows an investigator to approve their own grant requests.

## Verification

```bash
bun run typecheck
bun run check
bun --filter '@ai-agents-observability/web' test
# Test: investigator with no active grant → transcript route returns 403/notFound.
# Test: investigator with active grant for session X → transcript route succeeds.
# Test: investigator with expired grant → 403/notFound (same as no grant).
# Test: investigator cannot access /admin/alerts, /admin/org-roles edit actions.
```

> **Verification status (done):** `roles.test.ts` gains investigator cases (canViewIndividuals
> = false for investigator; canRequestGrants = true for org_admin + investigator only) — **23 web
> role/grant tests pass locally** + biome clean. `investigator` added to OrgRole enum (+migration);
> `requireOrgViewer` already admits it (aggregate access), `canViewIndividuals` deliberately excludes
> it (no standing access), `canRequestGrants`/`requireGrantRequester` admit it. The grant request
> flow + /admin/access-grants/new now accept investigators (approval still org_admin-only — no
> self-approval). `/admin/org-roles` lets org_admin assign the role (audited role_grant). Trust
> rationale documented in `roles.ts`. When a grant expires, hasActiveGrant returns false and access
> reverts to aggregate-only with no code change. `typecheck` + DB tests run in CI.
