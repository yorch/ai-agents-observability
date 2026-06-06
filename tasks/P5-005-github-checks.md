# P5-005 — GitHub Checks correlation

**Status**: done
**Phase**: 5 — Effectiveness signals
**Estimate**: L
**Depends on**: P2-003

## Goal

Count failed GitHub Check runs against their associated PRs and surface the cumulative failure count on the PR rollup. This gives teams a signal for how often CI failures occur on AI-authored PRs.

## Acceptance criteria

- [ ] The webhook router handles `check_run` events.
- [ ] When a check run completes with `conclusion === 'failure'` or `conclusion === 'action_required'`, `pr_rollups.check_failures_count` is incremented for each associated PR.
- [ ] The `/me/prs` table shows a "Checks" column with `⚠ N` in amber when failures exist, or `—` otherwise.

## Implementation notes

Handler added inside the async void IIFE in `apps/github-app/src/routes/webhooks.ts`, after the `pull_request` block.

The `check_run` payload shape used:
```ts
{
  check_run: {
    conclusion: string | null;
    pull_requests: Array<{ number: number }>;
  };
  repository: { full_name: string };
}
```

For each associated PR, the handler:
1. Splits `repoFullName` into `owner`/`name`.
2. Does a `repo.findFirst` to resolve the repo's UUID (needed for the composite PK on `pr_rollups`).
3. Calls `pRRollup.updateMany` with `{ checkFailuresCount: { increment: 1 } }`.

Schema field: `pr_rollups.check_failures_count INT DEFAULT 0`

Note: The handler only fires for `conclusion === 'failure' | 'action_required'` — successful and skipped check runs do not increment the counter.
