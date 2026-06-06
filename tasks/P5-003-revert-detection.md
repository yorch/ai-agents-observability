# P5-003 — Revert detection

**Status**: done
**Phase**: 5 — Effectiveness signals
**Estimate**: M
**Depends on**: P2-005

## Goal

Detect when a merged PR is a GitHub-generated revert of another PR, and record that relationship in the database. This allows the dashboard to surface "this PR was reverted" as a quality signal.

## Acceptance criteria

- [ ] When a PR with title matching `/^Revert\s+["""]/i` and body containing `Reverts #N` is merged, the original PR (`#N`) gets `reverted_at` set to the merge timestamp.
- [ ] The reverting PR itself gets `revert_of_pr_number = N` recorded.
- [ ] The detection is logged at `info` level as `pr.revert.detected` with `{ originalPrNumber, prNumber }`.
- [ ] A "reverted" badge appears in the `/me/prs` table next to the PR title.

## Implementation notes

Detection runs in `apps/github-app/src/handlers/pull-request.ts` after `computePRRollup` succeeds on a merged PR.

GitHub auto-generates revert PRs with:
- Title: `Revert "<original title>"`
- Body: `Reverts #<original PR number>`

Two DB writes on detection:
1. `pullRequest.updateMany` to set `revertedAt` on the original PR (scoped to same `repoId`).
2. `pullRequest.update` to set `revertOfPrNumber` on the reverting PR itself.

Schema fields (`packages/db/prisma/schema.prisma`):
- `pull_requests.reverted_at TIMESTAMPTZ` — set on the original PR when reverted
- `pull_requests.revert_of_pr_number INT` — set on the reverting PR

Web UI (`apps/web/src/app/me/prs/page.tsx`): shows a red "reverted" badge next to the PR title when `revertedAt` is non-null.
