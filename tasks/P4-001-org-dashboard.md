---
id: P4-001
title: viewer_aggregate role + org dashboard
phase: 4
workstream: A
status: done
owner: claude
depends_on: [P3-001]
blocks: [P4-002, P4-005]
estimate: L
---

## Goal

Add `OrgRole` to the User model (`member`, `org_admin`, `viewer_aggregate`), implement role-gated org-level route helpers, and build the `/org/dashboard` page showing cost by team, repo, and model with a weekly trend and anomaly banners.

## Acceptance criteria

- [x] `OrgRole` enum added to Prisma schema + migration applied
- [x] `requireOrgViewer()` and `requireOrgAdmin()` helpers in `apps/web/src/lib/roles.ts`
- [x] `viewer_aggregate` sees aggregates only — no individual session rows
- [x] `/org/dashboard` shows: summary cards, weekly cost trend bars, cost-by-team table, cost-by-repo table, cost-by-model bar chart, top tools
- [x] Anomaly banners: spend spike (>2σ over 14-day baseline) and high tool error rate (>10%)
- [x] Nav shows "Org" link only for non-member org roles
- [x] All queries respect `shareMetadataWithOrg` visibility policy

## Files touched

- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/20260606000000_phase4_phase5/migration.sql`
- `apps/web/src/lib/roles.ts`
- `apps/web/src/lib/org-queries.ts` (new)
- `apps/web/src/app/org/layout.tsx` (new)
- `apps/web/src/app/org/dashboard/page.tsx` (new)
- `apps/web/src/components/Nav.tsx`
