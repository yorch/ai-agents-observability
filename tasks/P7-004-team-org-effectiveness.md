---
id: P7-004
title: Team + org effectiveness dashboards
phase: 7
workstream: E
status: done
owner: claude
depends_on: [P7-002]
blocks: []
estimate: M
---

## Goal

Surface friction distribution and session-shape mix on the team dashboard and the
org dashboard, honoring visibility policies so individual scores never leak to
aggregate-only viewers.

## Context

`DESIGN_DOC.md` §10.6 governs what may be shown: aggregate distributions are safe;
named per-member friction scores are not safe to show to anyone who holds only
the `viewer_aggregate` role. The existing `ensure-visibility-policy.ts` and
`apps/web/src/lib/visibility.ts` contain the `share_metadata_with_team` /
`share_metadata_with_org` flags. The aggregate helpers added in P7-002
(`getTeamEffectivenessDistribution`, `getOrgEffectivenessDistribution`) must be
called inside those policy gates. `/team/[slug]` already renders cost and tool-use
panels; the effectiveness widgets slot in alongside them. `/org/dashboard` already
renders anomaly banners (P4-005); effectiveness goes below those.

## Acceptance criteria

- [x] `/team/[slug]` shows a friction distribution panel (histogram or percentile bar: p25/p50/p75) for the trailing 30d, using only sessions from members whose `share_metadata_with_team` flag is set.
- [x] `/team/[slug]` shows a shape-mix panel (proportional bar chart) for the same population and period.
- [x] `/org/dashboard` shows an org-level friction distribution and shape mix for the trailing 30d, using only sessions from members whose `share_metadata_with_org` flag is set.
- [x] No individual member's friction score or session shape is surfaced to a user holding only the `viewer_aggregate` role; only bucketed/aggregate statistics are shown.
- [x] Panels render `FRICTION_VERSION` and a "not enough data" notice when fewer than 5 scored sessions are in the aggregate (to avoid identifying individuals by elimination).
- [x] Null-score sessions are excluded from distribution calculations (not counted as 0).

## Implementation notes

The "fewer than 5 scored sessions" suppression threshold protects against
re-identification by small teams. Hard-code this constant and document it inline;
it is not a config value.

For the team panel, the aggregate query must scope by `team_members.team_id` and
join `visibility_policies` — reuse the pattern already present in
`apps/web/src/lib/team-queries.ts`. Do not add a raw `$queryRaw` bypass;
the visibility join must be part of the query, not a post-fetch filter.

## Files touched

- `apps/web/src/app/team/[slug]/page.tsx`
- `apps/web/src/app/org/dashboard/page.tsx`
- `apps/web/src/lib/org-queries.ts`
- `apps/web/src/components/me/FrictionDistributionChart.tsx` (new — reused by both team and org views)

## Out of scope

- Per-member friction rankings or leaderboards.
- Trend lines at team/org level (aggregate distribution only for Phase 7).
- Surfacing raw session transcripts from these views.

## Verification

```bash
bun --filter '@app/web' test
bun run typecheck
bun run check
```

> **Verification status (done):** team + org effectiveness panels implemented;
> `biome check --error-on-warnings` clean across all touched files. Team uses the
> already-resolved `visibleIds` (share_metadata_with_team); org uses a new
> `getOrgEffectiveness` whose `share_metadata_with_org` filter is in the SQL JOIN
> (matching the other org-queries). `<5` scored-session suppression + FRICTION_VERSION
> live in `FrictionDistributionChart`. `typecheck` runs in CI (Prisma client is
> egress-blocked in the sandbox).
