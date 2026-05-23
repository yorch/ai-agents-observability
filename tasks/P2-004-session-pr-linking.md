---
id: P2-004
title: Session ↔ PR linking (real-time + backfill)
phase: 2
workstream: B
status: ready
owner: null
depends_on: [P2-003]
blocks: [P2-005]
estimate: M
---

## Goal

`SessionPRLink` rows are created by two paths: (1) at ingest time when `session_context.git.pr_number` is present, and (2) at PR close time via a branch-name backfill over unlinked sessions.

## Context

- `DESIGN_DOC.md` §7.3 — the hook captures the open PR number at `SessionStart`. That's the fast path.
- `DESIGN_DOC.md` §7.2 — at PR merge, a reconciliation pass links sessions on the same branch that were missed (e.g., sessions that started before the PR was opened, or when `gh pr view` failed on the client).
- The `SessionPRLink` Prisma model already exists. `link_source` distinguishes the two paths: `session_start` vs `webhook_reconcile`.

## Acceptance criteria

**Path 1 — ingest-time linking (`link_source = session_start`):**
- [ ] After `upsertSessions` in `apps/ingest/src/routes/events.ts`, if a session's aggregated `prNumber` is non-null and a `PullRequest` row exists for `(repoId, prNumber)`, upsert a `SessionPRLink` row.
- [ ] Uses `upsert` with `skipDuplicates` (or `ON CONFLICT DO NOTHING`). Idempotent.
- [ ] If the `PullRequest` row doesn't exist yet (webhook hasn't arrived), silently skip — the backfill in Path 2 will catch it at close time.
- [ ] Does not block the `/v1/events` response — runs after the upsert, in the same request handler, but is a best-effort fire-and-forget (catch errors, log, don't propagate).

**Path 2 — webhook backfill at PR close (`link_source = webhook_reconcile`):**
- [ ] When a `pull_request.closed` (merged) event is processed (P2-003), after upserting the `PullRequest` row, call `backfillPRLinks(db, repoId, prNumber, headBranch)`.
- [ ] `backfillPRLinks` finds all `Session` rows where `repo_id = repoId AND git_branch = headBranch AND session_id NOT IN (existing SessionPRLink for this PR)` and bulk-inserts `SessionPRLink` rows with `link_source = webhook_reconcile`.
- [ ] Idempotent: re-running on the same PR produces no duplicates.
- [ ] Test: seed sessions with matching `repo_id + git_branch`; call `backfillPRLinks`; assert correct `SessionPRLink` rows.

## Implementation notes

- Path 1 lives in `apps/ingest` — keep the change minimal (a few lines after `upsertSessions`).
- Path 2 lives in `apps/github-app` — called from the `pull_request.closed` handler.
- `git_branch` matching is case-sensitive and exact. Don't normalize (branch names can legitimately differ by case on some GHES setups).
- Scope the backfill query: `started_at >= pr.opened_at - interval '7 days'` to avoid linking very old sessions to freshly-opened branches. The 7-day window is conservative; adjust in Phase 5 if needed.

## Files touched

- `apps/ingest/src/routes/events.ts` (Path 1: call link helper after upsertSessions)
- `apps/ingest/src/lib/session-pr-link.ts` (new: real-time link upsert)
- `apps/github-app/src/lib/backfill-pr-links.ts` (new: branch-match backfill)
- `apps/github-app/src/handlers/pull-request.ts` (call backfill on merge)
- `apps/ingest/test/session-pr-link.test.ts` (new)
- `apps/github-app/test/backfill-pr-links.test.ts` (new)

## Out of scope

- `manual` link source (Phase 3 team-lead feature).
- `push` event-based commit correlation (Phase 4).
- Linking sessions to multiple PRs (can happen with cherry-picks; ignore for v1).

## Verification

```bash
bun --filter '@ai-agents-observability/ingest' test
bun --filter '@ai-agents-observability/github-app' test

# Manual:
# 1. POST events to /v1/events with pr_number set and a matching PullRequest row in DB.
# 2. Check session_pr_links for link_source = 'session_start'.
# 3. Merge a PR via webhook; check session_pr_links for link_source = 'webhook_reconcile'.
psql "$DATABASE_URL" -c "SELECT session_id, link_source FROM session_pr_links ORDER BY linked_at DESC LIMIT 10;"
```
