---
id: P2-003
title: PR upsert and close event handlers
phase: 2
workstream: B
status: ready
owner: null
depends_on: [P2-002]
blocks: [P2-004, P2-010]
estimate: M
---

## Goal

`pull_request.opened`, `pull_request.synchronize`, and `pull_request.closed` (merged) webhook events upsert `PullRequest` rows in Postgres. On merge, a rollup-computation job is enqueued.

## Context

- `DESIGN_DOC.md` §7.2 — PR lifecycle events drive the `pull_requests` table and ultimately the `pr_rollups` table.
- The `PullRequest` and `PRRollup` Prisma models already exist (Phase 1 schema). This task wires the write path.
- "Enqueue rollup" in Phase 2 means: call the rollup function directly (P2-005); a proper job queue is Phase 4.

## Acceptance criteria

- [ ] `pull_request.opened` and `pull_request.synchronize`:
  - Upsert `PullRequest` row keyed on `(repo_id, pr_number)`.
  - Lazily upsert the `Repo` row (same pattern as `apps/ingest` events handler).
  - Resolve `author_user_id` by matching `payload.pull_request.user.login` to `users.github_login`. `null` if no match (user may not have installed the hook).
  - Populate: `github_id`, `title`, `state`, `base_branch`, `head_branch`, `opened_at`, `author_github_login`, `labels`, `reviewer_logins`.
- [ ] `pull_request.closed` with `payload.pull_request.merged == true`:
  - Update `PullRequest`: set `state = merged`, `closed_at`, `merged_at`, `lines_added`, `lines_removed`, `files_changed`, `review_count`.
  - Trigger rollup computation (call `computePRRollup(db, repoId, prNumber)` — implemented in P2-005; stub a no-op for now).
- [ ] `pull_request.closed` with `merged == false`:
  - Update `PullRequest`: set `state = closed`, `closed_at`.
  - No rollup.
- [ ] All handlers log at info level: `{ event, repo, pr_number, action }`.
- [ ] Test: synthetic webhook payloads for each case; assert DB state after handler runs. Use an in-memory Prisma mock or a real test DB.

## Implementation notes

- Map GitHub's `state` field + `merged` flag to the `PRState` enum: `open`, `closed`, `merged`.
- `lines_added` / `lines_removed` / `files_changed` come from `payload.pull_request.additions`, `.deletions`, `.changed_files`. These are present in `closed` events; absent in `opened`.
- `review_count`: not in the webhook payload directly. Either skip for now (set `null`) or fetch via REST (`GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`). Fetching costs an extra API call; skip for v1 and note the gap.
- The handler is registered in `apps/github-app/src/routes/webhooks.ts` via `webhooks.on('pull_request', handler)`.

## Files touched

- `apps/github-app/src/handlers/pull-request.ts`
- `apps/github-app/src/lib/pr-upsert.ts`
- `apps/github-app/src/routes/webhooks.ts` (register handler)
- `apps/github-app/src/types.ts` (add db type)
- `apps/github-app/test/pull-request.test.ts`

## Out of scope

- Session ↔ PR linking (P2-004).
- Actual rollup computation (P2-005).
- `push` event handling (deferred to Phase 4 — commit correlation).
- `review_count` enrichment (deferred; set null for now).

## Verification

```bash
bun --filter '@ai-agents-observability/github-app' test

# Manual (requires P2-002 running + smee.io forwarding):
# Open/close a PR on the test repo; check:
psql "$DATABASE_URL" -c "SELECT pr_number, state, merged_at FROM pull_requests ORDER BY enriched_at DESC LIMIT 5;"
```
