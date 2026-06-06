# P5-004 — Jira integration (key extraction)

**Status**: done
**Phase**: 5 — Effectiveness signals
**Estimate**: L (this task covers key extraction only; full Jira API integration is deferred)
**Depends on**: §13 Q6 answer (Jira API credentials scope)

## Goal

Extract Jira issue keys from PR head branch names and store them on the `pull_requests` row. This allows cross-referencing PRs with Jira issues without any Jira API calls.

## Acceptance criteria

- [ ] `extractJiraKey(branch)` exported from `apps/github-app/src/lib/pr-upsert.ts` returns the first match of `/([A-Z][A-Z0-9]+-\d+)/` or `null`.
- [ ] `jiraKey` is written to both `create` and `update` paths in `doUpsert`.
- [ ] The `/me/prs` table shows a Jira link column: linked to `${NEXT_PUBLIC_JIRA_BASE_URL}/browse/${key}` if that env var is set, otherwise shown as plain text.

## Implementation notes

This is the **key-extraction-only** part of the Jira integration. No Jira REST API calls are made. The full integration (linking to actual Jira issues, syncing status) is blocked on §13 Q6 (what Jira API credentials the org wants to use).

Key extraction via regex in `apps/github-app/src/lib/pr-upsert.ts`:
```ts
export function extractJiraKey(branch: string): string | null {
  const match = /([A-Z][A-Z0-9]+-\d+)/.exec(branch);
  return match?.[1] ?? null;
}
```

Schema field: `pull_requests.jira_key TEXT`

Web UI: reads `process.env.NEXT_PUBLIC_JIRA_BASE_URL` at the top of the PRsPage server component, strips trailing slash, and passes `jiraBase` down to the table component. Jira links open in a new tab when `jiraBase` is configured.
