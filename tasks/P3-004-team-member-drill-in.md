---
id: P3-004
title: Drill-in to team member sessions
phase: 3
workstream: B
status: done
owner: claude
depends_on: [P3-003, P3-005]
blocks: []
estimate: M
---

## Goal

A team lead can view the session list for a specific team member, gated by `share_metadata_with_team`. The transcript viewer for those sessions is further gated by `share_transcripts_with_team`. Every view writes an audit log entry.

## Context

- `DESIGN_DOC.md` §8.1 — `team_lead` sees team sessions (metadata always; transcripts only if opted in).
- `DESIGN_DOC.md` §8.3 — every cross-user view writes an audit log row visible to the affected user.
- The existing `/me/sessions` components can be reused with a `userId` parameter.

## Acceptance criteria

- [x] `/team/[slug]/member/[login]` lists sessions for the named user.
- [x] Page renders only if: team lead auth passes AND member `share_metadata_with_team = true`; otherwise 404.
- [x] Session detail at `/team/[slug]/member/[login]/sessions/[id]` is gated by the same policy.
- [x] Transcript at `.../sessions/[id]/transcript` requires `share_transcripts_with_team = true`; if false, shows a "Member hasn't shared transcripts" notice.
- [x] `view_session` audit log row written per session list load (targetUserId = member.id).
- [x] `view_transcript` audit log row written per transcript view (targetUserId + targetSessionId).
- [x] TypeScript and Biome clean.

## Files touched

- `apps/web/src/app/team/[slug]/member/[login]/page.tsx` (new)
- `apps/web/src/app/team/[slug]/member/[login]/sessions/[id]/page.tsx` (new)
- `apps/web/src/app/team/[slug]/member/[login]/sessions/[id]/transcript/page.tsx` (new)
- `apps/web/src/app/api/team/[slug]/member/[login]/transcripts/[id]/route.ts` (new — S3 proxy for team-scoped transcripts)
- `apps/web/src/components/me/SessionTabs.tsx` (new — shared ToolsTab + ModelsTab extracted from session detail pages)
- `apps/web/src/components/me/SessionsTable.tsx` (extend — optional `basePath` prop)
- `apps/web/src/components/me/TranscriptViewer.tsx` (extend — optional `apiUrl` prop)
- `apps/web/src/lib/team-queries.ts` (extend — `getMemberForTeam` + `MemberProfile` type)
- `apps/web/src/lib/audit.ts` (P3-005)
- `apps/web/src/app/team/[slug]/roster/page.tsx` (extend — member name links for canViewStats members)
- `packages/db/src/index.ts` (fix — `export * from './generated/client/enums'` so AuditAction value is re-exported)

## Out of scope

- Org-level cross-team drill-in (Phase 4).
- Justification-required transcript access for org admins (Phase 4).
