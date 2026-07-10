# P11-002 — Correlation follow-ups (allowlist, bug spend, jira facet)

**Status**: done
**Phase**: 11 — Correlation & Jira integration
**Estimate**: M
**Depends on**: P11-001

## Goal

Land the follow-ups deferred from P11-001: make key extraction precise once the
org's real Jira projects are known, surface the first bug-vs-feature analysis,
and finish the search integration.

## Scope

- **Project-key allowlist for extraction**: `extractJiraKey(FromSources)` accepts
  an optional set of known project codes; when non-empty, only keys with a known
  prefix are extracted (strictly stronger than the standards-token denylist,
  which remains the bootstrap-mode guard). The allowlist is the union of
  `JIRA_PROJECT_KEYS` (new env on ingest + github-app) and project keys learned
  by `sync-jira` (`jira_issues.project_key`), resolved via a 5-minute-cached
  `getJiraProjectAllowlist` in `packages/db` and applied on both the session
  (ingest) and PR (github-app) extraction paths.
- **Bug vs feature spend** (`/org/roi`): ticket session-spend grouped by
  `jira_issues.issue_type`, with Bug/Defect share of classified spend as the
  rework signal. Explicitly framed as spend-on-bug-tickets, not defect
  attribution; unclassified tickets are excluded from the share's denominator.
- **`jira` search facet** (`/org/search`): exact-key filter (case-insensitive)
  alongside the existing tool/shape/friction facets.
- **Team-FK query migration**: audited — no web query reads the denormalized
  `github_team` string (team scoping goes through `TeamMember` rosters), so
  there was nothing to migrate; `sessions.team_id` stands ready for future
  team-scoped session queries.

## Acceptance criteria

- [x] With `JIRA_PROJECT_KEYS=OBS` (or one synced OBS issue), `feat/FAKE-1`
      extracts no key while `feat/OBS-1` does — on both sessions and PRs.
- [x] With no configured or synced projects, extraction behaves as before
      (denylist-guarded bootstrap mode).
- [x] `/org/roi` shows bug-work spend/share and a per-issue-type breakdown.
- [x] `/org/search?jira=PROJ-123` filters sessions to that ticket.
- [x] All four gates pass.

## Still deferred

- Defect *attribution* (which PR introduced which bug) — needs Jira issue links
  or fix-version data the sync doesn't collect.
- Statistical correlation surfaces (bug rate vs session friction/shape).
