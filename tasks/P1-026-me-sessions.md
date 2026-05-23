---
id: P1-026
title: /me/sessions list + detail + transcript viewer
phase: 1
workstream: E
status: done
owner: claude
depends_on: [P1-024, P1-011, P1-012, P1-005]
blocks: [P1-029]
estimate: L
---

## Goal

Three connected pages: a filterable list of the user's sessions, a per-session detail page with event timeline, and a transcript viewer that streams from MinIO.

## Context

- `DESIGN_DOC.md` §6.5 ownership: only `Session.user_id == currentUser().id` allowed.
- Transcripts are large; viewer must stream, not load whole-file.

## Acceptance criteria

**List (`/me/sessions`):**
- [ ] Paginated table, 50/page, sorted by `started_at desc`.
- [ ] Columns: started_at, repo, duration, event_count, cost, status.
- [ ] Filters: repo (dropdown), date range, status. Filters via URL query params (server-rendered).
- [ ] Each row links to `/me/sessions/[id]`.

**Detail (`/me/sessions/[id]`):**
- [ ] 404 if session not owned by current user.
- [ ] Header: repo · branch · commit SHA · started/ended · cost · status.
- [ ] Tabs: Timeline, Tool usage, Model breakdown.
- [ ] Timeline: chronological event list (paginated/virtualized for large sessions). Each row: ts, event_type, tool/model name, duration, cost.
- [ ] Tool usage: bar chart from `Session.tool_usage`.
- [ ] Model breakdown: token + cost split by model.
- [ ] If transcript present, "View transcript" link to `/me/sessions/[id]/transcript`.

**Transcript (`/me/sessions/[id]/transcript`):**
- [ ] 404 if not owned.
- [ ] Streams the zstd-compressed JSONL from MinIO via a Next.js Route Handler proxy (`/api/me/transcripts/[id]`) that re-streams to the browser.
- [ ] Browser-side renderer: virtualized list, search-in-page, copy-message button.
- [ ] Each line shows role + content; tool calls collapsed by default.
- [ ] No download-the-whole-file shortcut — encourages "view in place" hygiene.

## Implementation notes

- Use a presigned S3 GET URL? No — we want to keep auth at the app layer and audit access. Proxy through the route handler.
- For the virtualized list, `react-virtuoso` is fine.
- Decompress zstd in the route handler (server-side); send plain JSONL to the browser, chunked.

## Files touched

- `apps/web/src/app/me/sessions/page.tsx`
- `apps/web/src/app/me/sessions/[id]/page.tsx`
- `apps/web/src/app/me/sessions/[id]/transcript/page.tsx`
- `apps/web/src/app/api/me/transcripts/[id]/route.ts`
- `apps/web/src/components/me/{SessionsTable,Timeline,TranscriptViewer}.tsx`
- `apps/web/src/lib/sessions-queries.ts`
- `apps/web/test/sessions.test.ts`

## Out of scope

- Sharing a session link with a teammate (Phase 3).
- Server-side search across transcripts (Phase 4).

## Verification

```bash
bun --filter '@pkg/db' db:seed
bun --filter '@app/web' dev
# Visit /me/sessions; click a row; click "View transcript".
bun --filter '@app/web' test
```
