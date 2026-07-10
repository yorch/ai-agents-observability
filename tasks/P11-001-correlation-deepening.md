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
  `review_count`; already-tracked PRs are not rewritten from the slim review
  payload); `check_run` → `pr_check_runs` per-run history (the failure counter is
  now derived from those rows — idempotent under redeliveries); `push` on the
  default branch → `session_commit_links` via author + timestamp window
  (`COMMIT_LINK_GRACE_HOURS`, default 24h; DESIGN_DOC §7.2), keeping
  `repos.default_branch` current.
- `sessions.team_id` FK resolved at ingest from the hook-reported team name
  (unambiguous names only).

### Surfacing
- `/org/roi`: spend-by-ticket table now dual-grain (PR-rollup spend + direct session
  spend, which counts pre-PR work) and enriched with `jira_issues` metadata; new
  spend-by-project rollup (key-prefix grouping, works pre-sync; display names from
  `jira_issues.project_name`); new spend-by-epic rollup; "merged-work provenance"
  cards from `session_commit_links` (the §10.5-sanctioned substitute for LOC metrics).
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

## Follow-ups

Landed in [P11-002](./P11-002-correlation-follow-ups.md): project-key allowlist for
extraction, bug-vs-feature spend, the `jira` search facet, and the team-FK query
audit (nothing to migrate). Still deferred there: defect attribution and
statistical bug-rate correlation. Also still deliberately omitted here: fetching
PR commit SHAs on `synchronize` (avoids an API call per push).
