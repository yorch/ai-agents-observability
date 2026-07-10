# P11-003 — Defect attribution & quality correlation

**Status**: done
**Phase**: 11 — Correlation & Jira integration
**Estimate**: M
**Depends on**: P11-002

## Goal

Close the last two deferred items from the correlation work: attribute bugs to
the tracked work they're linked to, and surface the §3.5 quality-correlation
question (do PRs from high-friction sessions have worse outcomes?).

## Scope

- **Issue-link sync**: `sync-jira` also requests `issuelinks` + `created`;
  links are snapshotted per issue into a new `jira_issue_links` table
  (source/target/type + the relation phrase verbatim), and
  `jira_issues.issue_created_at` is stored. Link *targets* become sync
  candidates on the next run, so a bug linked to a tracked ticket gets its
  issue-type metadata even though nobody works on the bug in a repo.
- **Defect attribution** (`/org/quality`): Bug/Defect-type issues linked
  (either direction) to a ticket whose PRs we track, with the origin ticket's
  merged-PR count and rollup spend. The link phrase ("is caused by" vs
  "relates to") is shown verbatim — the table reports linkage; causation is a
  human judgement.
- **Outcome rates by friction band** (`/org/quality`): merged PRs bucketed by
  the mean friction score of their contributing sessions (existing 0.3/0.6
  thresholds); per band: revert rate, CI-failure rate, bug-linked rate, avg
  cost. Revert + CI rates work without Jira. Bands under 10 PRs render muted
  with a "small sample" flag — association, never causation, and never a
  confident number off a handful of PRs.

## Acceptance criteria

- [x] Syncing an issue snapshots its links with the perspective-correct phrase.
- [x] A bug linked to a tracked ticket appears in the attribution table with
      origin spend, without the bug ever having a branch/PR of its own.
- [x] Friction-band outcome table renders with small-sample suppression;
      revert/CI columns populate without any Jira configuration.
- [x] All four gates pass.

## Still deferred

- ~~Formal significance testing on the band deltas~~ — landed in
  [P11-004](./P11-004-band-significance.md) (Fisher's exact is valid at any
  n, so it ships now and reaches significance only once volume exists).
- Post-merge defect *windows* (bug created within N days of a merge, no
  explicit link) — `issue_created_at` is now stored, so this is query-only
  work when wanted, but it is heuristic and stays out until someone asks.
