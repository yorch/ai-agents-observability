# P11-001 — Correlation deepening (sessions ↔ PRs ↔ repos ↔ Jira)

**Status**: done
**Phase**: 11 — Correlation & Jira integration
**Estimate**: L
**Depends on**: P2-004, P5-004, P5-005

## Goal

Close the correlation gaps found in the session↔PR↔ticket investigation: use every
matching key the platform already captures (commit SHA, branch, PR number, Jira key,
team name), collect the GitHub signals it was discarding (reviews, per-check outcomes,
default-branch commits), and turn the regex-only Jira integration into a real one.

## Scope (shipped in one PR)

### Collection & correlation
- `extractJiraKey` shared via `packages/schemas`; PR extraction falls back
  branch → title → body; sessions get their own `jira_key` from the git branch at ingest.
- Env-gated `sync-jira` ingest job (`JIRA_BASE_URL` + `JIRA_API_TOKEN`; `JIRA_EMAIL`
  selects Cloud Basic auth vs Server/DC Bearer PAT; optional
  `JIRA_STORY_POINTS_FIELD` / `JIRA_EPIC_LINK_FIELD`) → `jira_issues` table.
- Session↔PR backfill hardening: commit-SHA matching at merge (PR commit list via the
  installation token), branch-only backfill on `opened`/`synchronize`, window
  configurable via `PR_LINK_LOOKBACK_DAYS`, and a MANUAL link/unlink UI on the
  own-session page (recomputes the rollup; `computePRRollup` moved to `packages/db`).
- New webhook handlers: `pull_request_review` → `pr_reviews` (+ maintained
  `review_count`); `check_run` → `pr_check_runs` per-run history (failure counter
  preserved); `push` on the default branch → `session_commit_links` via
  author + timestamp window (DESIGN_DOC §7.2), keeping `repos.default_branch` current.
- `sessions.team_id` FK resolved at ingest from the hook-reported team name
  (unambiguous names only).

### Surfacing
- `/org/roi`: spend-by-ticket table now dual-grain (PR-rollup spend + direct session
  spend, which counts pre-PR work) and enriched with `jira_issues` metadata; new
  spend-by-epic rollup; "merged-work provenance" cards from `session_commit_links`
  (the §10.5-sanctioned substitute for LOC metrics).
- `/org/delivery`: review health (median time-to-first-review, reviews/PR) from
  `pr_reviews`; failing-checks table (runs, failures, failure rate) from `pr_check_runs`.
- `/me/sessions`: Ticket column (session `jira_key`, linked when
  `NEXT_PUBLIC_JIRA_BASE_URL` is set).

## Acceptance criteria

- [x] All four gates pass (`check`, `typecheck`, `build`, `test`).
- [x] A session on a rebased/renamed branch links to its PR at merge via commit SHA.
- [x] Open PRs acquire session links at `opened`/`synchronize` without waiting for merge.
- [x] With Jira configured, `jira_issues` rows appear for extracted keys and `/org/roi`
      shows summaries/status and epic rollups.
- [x] `sync-jira` is manually triggerable via the admin jobs endpoint and no-ops with a
      warning when Jira is unconfigured.

## Follow-ups (not in scope)

- Migrate team-scoped queries from the `github_team` string to `sessions.team_id`.
- `jira_key` facet in org faceted search.
- Bug-correlation analysis surface (`jira_issues.issue_type = 'Bug'` → PR → session
  characteristics) — the join now exists.
- Fetch PR commit SHAs on `synchronize` (deliberately omitted to avoid an API call per push).
