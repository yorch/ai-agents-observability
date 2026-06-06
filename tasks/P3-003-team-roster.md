---
id: P3-003
title: /team/[slug]/roster page
phase: 3
workstream: B
status: done
owner: null
depends_on: [P3-001, P3-005]
blocks: [P3-004]
estimate: M
---

## Goal

A roster page listing team members with their high-level activity summary (session count, total cost) for the trailing 30 days. Gated by the member's `share_metadata_with_team` visibility policy. Writes one `export_team` audit log entry per page load.

## Context

- `DESIGN_DOC.md` §8.2 — `share_metadata_with_team` controls whether the team lead sees cost + session counts per member.
- Members who have opted out (`share_metadata_with_team = false`) appear in the roster with name/login shown but cost/session counts hidden ("Privacy opted out").
- The visibility policy defaults to ON — most members will show data.
- `DESIGN_DOC.md` §8.3 — every cross-user view writes an audit log row.

## Acceptance criteria

- [ ] `/team/[slug]/roster` lists all active team members.
- [ ] For each member with `share_metadata_with_team = true`: show 30-day session count + cost.
- [ ] For each member with `share_metadata_with_team = false` (or no policy row): show "Privacy opted out" in place of stats.
- [ ] One `export_team` audit log row written per page load (actor = team lead, targetTeamId = team.id).
- [ ] `requireTeamLead(slug)` gates the page.
- [ ] TypeScript and Biome clean.

## Files touched

- `apps/web/src/app/team/[slug]/roster/page.tsx` (new)
- `apps/web/src/lib/team-queries.ts` (extend with `getTeamRoster`)
- `apps/web/src/lib/audit.ts` (created by P3-005)

## Out of scope

- Drill-in to individual sessions (P3-004).
- Download / CSV export (Phase 4).
