---
id: P3-004
title: Drill-in to team member sessions
phase: 3
workstream: B
status: ready
owner: null
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

- [ ] `/team/[slug]/member/[login]` lists sessions for the named user.
- [ ] Page renders only if: team lead auth passes AND member `share_metadata_with_team = true`; otherwise 404.
- [ ] Session detail at `/team/[slug]/member/[login]/sessions/[id]` is gated by the same policy.
- [ ] Transcript at `.../sessions/[id]/transcript` requires `share_transcripts_with_team = true`; if false, shows a "Member hasn't shared transcripts" notice.
- [ ] `view_session` audit log row written per session list load (targetUserId = member.id).
- [ ] `view_transcript` audit log row written per transcript view (targetUserId + targetSessionId).
- [ ] TypeScript and Biome clean.

## Files touched

- `apps/web/src/app/team/[slug]/member/[login]/page.tsx` (new)
- `apps/web/src/app/team/[slug]/member/[login]/sessions/[id]/page.tsx` (new)
- `apps/web/src/app/team/[slug]/member/[login]/sessions/[id]/transcript/page.tsx` (new)
- `apps/web/src/lib/team-queries.ts` (extend with member session queries)
- `apps/web/src/lib/audit.ts` (P3-005)

## Out of scope

- Org-level cross-team drill-in (Phase 4).
- Justification-required transcript access for org admins (Phase 4).
