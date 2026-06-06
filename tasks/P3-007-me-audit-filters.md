---
id: P3-007
title: /me/audit with filters + real Phase 3 data
phase: 3
workstream: B
status: ready
owner: null
depends_on: [P3-005]
blocks: []
estimate: S
---

## Goal

The existing `/me/audit` page is populated by real audit rows generated in Phase 3 (roster views, session drill-ins, transcript views). Add filters for actor, date range, and action type so it's actually useful.

## Context

- `/me/audit` was scaffolded in P1-027. Before Phase 3, no real rows were written so it was always empty.
- `DESIGN_DOC.md` §8.3 — "The affected user can see 'Bob looked at your session from Tuesday' inside their My Agents page."
- Phase 3 generates `view_session`, `view_transcript`, `export_team` rows — the page becomes meaningful.

## Acceptance criteria

- [ ] `/me/audit` lists audit log rows where `target_user_id = currentUser.id`, newest first, paginated (25/page).
- [ ] Filter by action type (view_session, view_transcript, export_team).
- [ ] Filter by date range (last 7 days / 30 days / all time).
- [ ] Each row shows: actor GitHub login, action, timestamp, session link (if targetSessionId set).
- [ ] Empty state: "No one has accessed your data" when no rows.
- [ ] TypeScript and Biome clean.

## Files touched

- `apps/web/src/app/me/audit/page.tsx` (update existing page)
- `apps/web/src/lib/me-queries.ts` (add `getAuditLog(userId, filters)`)

## Out of scope

- Actor-perspective audit (what you've looked at) — Phase 4.
- Export / download audit log — Phase 4.
