---
id: P2-005
title: PR rollup computation
phase: 2
workstream: B
status: ready
owner: null
depends_on: [P2-004]
blocks: [P2-006, P2-008]
estimate: M
---

## Goal

On PR merge, aggregate all linked `Session` rows into a `PRRollup` record. The rollup is idempotent and recomputable from the source rows at any time.

## Context

- `DESIGN_DOC.md` §7.2 — "On merge: finalize PR rollup, compute final cost, link contributing sessions, snapshot lines changed."
- The `PRRollup` Prisma model already exists (Phase 1 schema). This task writes the computation logic and wires it into the merge handler.
- The rollup is a snapshot, not a live view — it's computed once at merge and stored. If sessions are later amended (edge case), it can be recomputed by re-calling this function.

## Acceptance criteria

- [ ] `computePRRollup(db, repoId, prNumber)` function that:
  1. Fetches all `SessionPRLink` rows for `(repoId, prNumber)`.
  2. Fetches the linked `Session` rows.
  3. Computes:
     - `contributing_user_ids`: distinct `user_id` values.
     - `contributing_session_ids`: all session IDs.
     - `first_session_at` / `last_session_at`: min/max of `started_at`.
     - `total_cost_usd`: sum of `total_cost_usd`.
     - `total_input_tokens` / `total_output_tokens`: sums.
     - `total_tool_calls` / `total_tool_errors` / `total_permission_denies`: sums.
     - `total_active_seconds`: sum of `EXTRACT(EPOCH FROM (ended_at - started_at))` for sessions with non-null `ended_at`. Null if all sessions are still active.
     - `cost_per_loc`: `total_cost_usd / (lines_added + lines_removed)` from `PullRequest`. Null if PR has no LOC data.
  4. Upserts the `PRRollup` row (`ON CONFLICT (repo_id, pr_number) DO UPDATE`).
  5. Sets `computed_at = now()`.
- [ ] Returns `{ sessionCount, contributorCount, totalCostUsd }` for the caller to log.
- [ ] If `SessionPRLink` has zero rows (no sessions were linked), upserts a zeroed-out `PRRollup` rather than skipping — the merge is still a data point.
- [ ] Called from the `pull_request.closed` (merged) handler in P2-003. The stub from P2-003 is replaced.
- [ ] Test: seed sessions + links; call `computePRRollup`; assert rollup fields match expected values. Test zero-session case.

## Implementation notes

- All aggregation can be done in TypeScript (fetch rows, sum in-process) for v1. A single Prisma query with aggregate functions is equally fine if it's cleaner.
- `total_active_seconds` should exclude sessions still `active` (no `ended_at`). Don't null out the whole sum if some sessions are active — sum what you have and note the gap.
- `cost_per_loc` is informational and often noisy. Set it to null if `lines_added + lines_removed == 0` to avoid division by zero.

## Files touched

- `apps/github-app/src/lib/pr-rollup.ts` (new)
- `apps/github-app/src/handlers/pull-request.ts` (replace stub call with real implementation)
- `apps/github-app/test/pr-rollup.test.ts` (new)

## Out of scope

- Incremental rollup updates when sessions are amended post-merge (Phase 4).
- Cross-PR aggregates (Phase 3/4 org views).
- Cost-per-LOC charts on the `/me/prs` page (P2-008 uses the stored value).

## Verification

```bash
bun --filter '@ai-agents-observability/github-app' test

# Manual after a merged PR:
psql "$DATABASE_URL" -c "
  SELECT pr_number, total_cost_usd, contributing_session_ids, computed_at
  FROM pr_rollups ORDER BY computed_at DESC LIMIT 5;
"
```
