---
id: P2-008
title: /me/prs page — per-user PR list with rollups
phase: 2
workstream: E
status: done
owner: null
depends_on: [P2-005]
blocks: []
estimate: M
---

## Goal

`/me/prs` shows the signed-in user a list of their PRs with cost-per-PR, session counts, and time spent. Links back to the sessions that contributed. Follows the same RSC patterns as `/me/sessions`.

## Context

- `DESIGN_DOC.md` §12.2 — Phase 2 adds `/me/prs`.
- Data sources: `PullRequest` + `PRRollup` joined, filtered to sessions where `contributing_user_ids @> ARRAY[currentUser().id]`.
- User owns the view: only PRs where the current user contributed at least one session are shown.

## Acceptance criteria

**List (`/me/prs`):**
- [ ] Server Component page; no client-side data fetching.
- [ ] Paginated table, 25/page, sorted by `merged_at desc` (or `opened_at desc` for open PRs).
- [ ] Columns: repo, PR title (linked to GitHub PR), state (badge: open/closed/merged), merged_at, session count, contributors, total cost, time span.
- [ ] Filter by repo (URL param, server-rendered). Filter by state: open / merged / all (default: merged).
- [ ] Empty state when user has no PRs with linked sessions: friendly message explaining that PRs appear here once the GitHub App is installed and a PR is merged.
- [ ] Each row links to `/me/prs/[repo]/[pr_number]`.
- [ ] Loading skeleton via `loading.tsx`.

**Detail (`/me/prs/[repo]/[pr_number]`):**
- [ ] 404 if current user is not in `PRRollup.contributing_user_ids` for this PR.
- [ ] Header: PR title, repo, branch → base, opened_at / merged_at, state badge.
- [ ] Summary row: total cost, session count, contributor count, time span.
- [ ] Session list: all sessions in `contributing_session_ids`, same card style as `/me/sessions`. Each links to `/me/sessions/[id]`.
- [ ] If no rollup exists yet (PR still open): show the linked sessions without rollup totals.

## Implementation notes

- Query: `SELECT pr.*, r.* FROM pull_requests pr LEFT JOIN pr_rollups r USING (repo_id, pr_number) WHERE r.contributing_user_ids @> ARRAY[$userId::uuid]`. For open PRs with no rollup, join via `session_pr_links → sessions.user_id`.
- The `@>` (contains) operator on a UUID array works without a GIN index for small arrays; add a GIN index in a follow-up if performance degrades.
- PR title can be null if the webhook hasn't enriched it yet; fall back to `#<pr_number>`.
- `[repo]` in the URL is `owner/name` URL-encoded (i.e., `owner%2Fname`). Use `decodeURIComponent` in the route handler.

## Files touched

- `apps/web/src/app/me/prs/page.tsx`
- `apps/web/src/app/me/prs/loading.tsx`
- `apps/web/src/app/me/prs/[...pr]/page.tsx` (catch-all for `owner/name/number`)
- `apps/web/src/lib/pr-queries.ts` (new)
- `apps/web/src/components/me/PRsTable.tsx` (new)
- `apps/web/src/components/me/PRDetail.tsx` (new)
- `apps/web/test/prs.test.ts` (new)

## Out of scope

- Team-scoped PR views (Phase 3).
- Org-wide PR analytics (Phase 4).
- PR bot opt-in toggle on this page (Phase 3).

## Verification

```bash
bun --filter '@ai-agents-observability/db' db:seed   # seed includes PRRollup rows
bun --filter '@ai-agents-observability/web' dev
# Visit http://localhost:3000/me/prs
bun --filter '@ai-agents-observability/web' test
```
