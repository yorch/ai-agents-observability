---
id: P3-001
title: Role middleware (team_lead) + requireRole helper
phase: 3
workstream: A
status: done
owner: claude
depends_on: [P1-003, P1-014]
blocks: [P3-002, P3-003, P3-004, P3-005]
estimate: M
---

## Goal

A server-side helper `requireTeamLead(slug)` that resolves the current user's role in a team, enforces that they hold `lead` or `maintainer`, and returns a typed `TeamContext` object. The Next.js proxy is extended to protect `/team/*` routes behind the cookie-presence check.

## Context

- `DESIGN_DOC.md` §8.1 — roles: `member`, `team_lead`, `org_admin`, `viewer_aggregate`. Phase 3 adds the `team_lead` gate.
- The Prisma schema has `TeamRole` enum (`member`, `lead`, `maintainer`) on `TeamMember`. `maintainer` is a superset of `lead`.
- All `/team/*` routes must redirect to `/login` if unauthenticated (proxy) and return 404 if the user is not a lead in that team (server component).
- `apps/web/src/proxy.ts` already handles `/me/*`; extend its matcher.
- `getTeamRole(userId, teamId)` is the lower-level primitive used by audit middleware in P3-005.

## Acceptance criteria

- [x] `apps/web/src/lib/roles.ts` exports:
  - `requireTeamLead(slug: string): Promise<TeamContext>` — redirects to /login if unauth; 404 if team missing or user not lead/maintainer.
  - `requireTeamMember(slug: string): Promise<TeamContext>` — any active membership.
  - `getTeamRole(userId, teamId): Promise<TeamRole | null>` — pure lookup, no redirect.
  - `isLeadOrAbove(role: TeamRole): boolean` — utility predicate.
  - `TeamContext` type: `{ user, teamId, teamSlug, teamName, role }`.
- [x] `apps/web/src/proxy.ts` matcher includes `/team/:path*`.
- [x] Unit tests in `apps/web/src/lib/__tests__/roles.test.ts` covering: lead passes, member blocked, left member blocked, unknown team 404.
- [x] TypeScript clean (`bun run typecheck`).

## Implementation notes

- Use `notFound()` from `next/navigation` for unauthorized team access — avoids leaking team existence to non-members.
- Left-at check: `membership.leftAt` being non-null means the user has left the team.
- `requireTeamMember` is used for self-service team views in Phase 4; Phase 3 only uses `requireTeamLead`.
- Batch the two Prisma queries (team lookup + membership lookup) into a single query using `include` to save a round trip.

## Files touched

- `apps/web/src/lib/roles.ts` (new)
- `apps/web/src/lib/__tests__/roles.test.ts` (new)
- `apps/web/src/proxy.ts` (extend matcher)

## Out of scope

- `org_admin` role (Phase 4).
- `viewer_aggregate` role (Phase 4).
- Actual team pages (P3-002 through P3-007).

## Verification

```bash
bun run typecheck
bun run test --filter @ai-agents-observability/web
```
