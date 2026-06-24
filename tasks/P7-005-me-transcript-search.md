---
id: P7-005
title: /me transcript search (per-user FTS)
phase: 7
workstream: E
status: ready
owner: null
depends_on: [P4-003]
blocks: []
estimate: M
---

## Goal

Add per-user transcript full-text search at `/me/search` scoped strictly to the
requesting user's own sessions, reusing the existing `transcript_index` GIN index
and `plainto_tsquery` infrastructure from the org search path.

## Context

Transcript FTS already works at `apps/web/src/app/org/search/page.tsx` using the
`transcript_index` table (Postgres `tsvector` + GIN index, built by the nightly
`index-transcripts` job). That route is org-admin-only. Individual developers have
no way to search their own transcripts today. The fix is a scoped version of the
same query: add `AND ti.session_id IN (SELECT session_id FROM sessions WHERE user_id = $userId)`
as a predicate — the GIN index still applies, and cross-user leakage is structurally
impossible because the `user_id` comes from `currentUser()` on the server.

`apps/web/src/lib/org-queries.ts` contains the `searchTranscripts` reference
implementation. Extract the reusable FTS core into `search-queries.ts` and call it
from both routes rather than duplicating the SQL.

## Acceptance criteria

- [ ] `GET /me/search?q=<query>` renders a search results page with `ts_headline` excerpts and links to the matching session transcript.
- [ ] Results are scoped to the authenticated user's sessions only; no other user's sessions can appear regardless of query content.
- [ ] An empty or whitespace-only query renders a prompt ("Enter a term to search your transcripts") with no DB call.
- [ ] A query shorter than 2 characters after trimming is rejected with a user-facing notice, not a Postgres error.
- [ ] Results show the session date, repo, and a highlighted excerpt (≤3 excerpts per session).
- [ ] Page handles zero results gracefully with a "No matching sessions" message.
- [ ] The `user_id` scope predicate is part of the SQL query, not a post-fetch JS filter.

## Implementation notes

Reuse `plainto_tsquery('english', $query)` and `ts_headline` exactly as org search
does. The `transcript_index` table schema has `session_id` and `content_tsv` — join
to `sessions` on `session_id` to get `user_id`, repo, and `started_at`. Use
`currentUser()` from `apps/web/src/lib/auth.ts` to populate the `user_id` predicate;
do not accept it from the query string.

Pagination: limit to 20 sessions per page with a `page` query param. Consistent
with org search UX.

## Files touched

- `apps/web/src/app/me/search/page.tsx` (new)
- `apps/web/src/lib/search-queries.ts` (new — shared FTS core extracted from org search)
- `apps/web/src/app/org/search/page.tsx` (refactor to consume `search-queries.ts`)

## Out of scope

- Semantic / vector search (P7-007).
- Searching events or PR data (transcript index only).
- Search result export.
- Org-admin search changes beyond the shared-core refactor.

## Verification

```bash
bun --filter '@app/web' test
bun run typecheck
bun run check
```
