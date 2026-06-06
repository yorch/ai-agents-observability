---
id: P3-002
title: /team/[slug] overview page
phase: 3
workstream: B
status: done
owner: null
depends_on: [P3-001]
blocks: []
estimate: M
---

## Goal

A server-rendered `/team/[slug]` page visible to team leads and maintainers. Shows team-level aggregate metrics (cost, session count, top tools, model mix) for the trailing 30 days. No individual-attributable data on this page.

## Context

- `DESIGN_DOC.md` §8.1 — team_lead sees team aggregates; individual session data only with user opt-in.
- `DESIGN_DOC.md` §12.3 Phase 3 — "Team-scoped equivalents of the /me cards".
- Aggregates are computed from sessions where `user_id` is in the team's membership AND `share_metadata_with_org` is true (use the most permissive default policy for aggregates).
- No audit log write for this page — aggregate data is not individually attributable.

## Acceptance criteria

- [ ] `/team/[slug]` renders team name, 30-day cost, session count, active member count, top tools, model mix.
- [ ] `requireTeamLead(slug)` gates the page (404 for non-leads, redirect for unauth).
- [ ] `apps/web/src/lib/team-queries.ts` exports `getTeamSummary(teamId, since)`.
- [ ] A global layout at `apps/web/src/app/team/[slug]/layout.tsx` renders the team nav (Overview · Roster · PRs).
- [ ] 404 page for unknown slugs.
- [ ] TypeScript clean and Biome clean.

## Files touched

- `apps/web/src/app/team/[slug]/layout.tsx` (new)
- `apps/web/src/app/team/[slug]/page.tsx` (new)
- `apps/web/src/app/team/[slug]/not-found.tsx` (new)
- `apps/web/src/lib/team-queries.ts` (new)
- `apps/web/src/proxy.ts` (already extended by P3-001)

## Out of scope

- Drill-in to individual users (P3-003, P3-004).
- PR rollups at team level (Phase 4).
