---
id: P4-002
title: Faceted session search
phase: 4
workstream: C
status: done
owner: claude
depends_on: [P4-001]
blocks: []
estimate: M
---

## Goal

Org-level session search with composable filters (user, team, repo, model, tool, date range) and transcript FTS. Visibility-scoped at query time. `viewer_aggregate` role blocked from individual rows.

## Acceptance criteria

- [x] `/org/search` page with filter form (team, repo, model, tool, date from/to)
- [x] Transcript FTS search box (searches `transcript_index` table)
- [x] Results table with pagination (50/page)
- [x] Filters compose as AND; URL params persist filter state
- [x] `viewer_aggregate` sees empty results (not 403 — graceful degradation)
- [x] All session results scoped to `shareMetadataWithOrg=true` users

## Files touched

- `apps/web/src/lib/org-queries.ts` (searchSessions, searchTranscripts)
- `apps/web/src/app/org/search/page.tsx` (new)
