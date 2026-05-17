# Phase 2 — PR Loop (roadmap)

**Trigger to decompose**: P1-029 marked `done`.

## Goal recap

Tie agent activity to PR outcomes. GitHub App receives PR webhooks, links sessions to PRs, computes per-PR rollups, optionally posts a comment on merge. New `/me/prs` page.

See `DESIGN_DOC.md` §7 and §12.2.

## Sketched tasks

These will become P2-001 … P2-NNN files when Phase 2 starts. Each sketch is one paragraph — the real task file expands criteria/verification.

- **P2-001 GitHub App registration + manifest**
  Register a GitHub App against github.com + GHES manifest. Stores private key, webhook secret. App-level permissions: pull_requests:read, contents:read, checks:read. Subscribe: `pull_request`, `push`, `installation`.
- **P2-002 `apps/github-app` webhook handler**
  Bun + Hono service receiving webhooks, signature-validated. Routes by event type. Mirrors `apps/ingest` operational shape.
- **P2-003 PR upsert + close handlers**
  `pull_request.opened|synchronize|closed` events upsert `PullRequest` rows. On `closed && merged`, queue PR rollup.
- **P2-004 Session ↔ PR linking**
  When a session has `pr_number` in `session_context.git`, populate `SessionPRLink`. Also batch-backfill at PR close time using `(repo_id, branch)` matching.
- **P2-005 PR rollup computation**
  On merge, sum session aggregates linked to the PR into a `PRRollup` row. Idempotent; recompute on any session update.
- **P2-006 PR bot comment**
  Opt-in via `.claude-telemetry.yml` at the merge commit's tree. Comment format per `DESIGN_DOC.md` §7.4. Use installation token; respect rate limits.
- **P2-007 `.claude-telemetry.yml` parser**
  Schema for the config file (opt-in flags, masking preferences). Versioned. Tested against handwritten samples.
- **P2-008 `/me/prs` page**
  Per-user list of PRs with cost-per-PR, deltas vs previous PRs, time spent. Links to constituent sessions.
- **P2-009 Webhook delivery health metrics**
  Webhook receipt rate, failure rate, retry count. Surface on an internal `/admin/health` view; alerts in Phase 4.
- **P2-010 GHES integration test**
  Spin up a GHES-in-Docker (or use a sandbox) and verify webhook + comment flows work identically.

## Exit criteria

- [ ] PR bot comments appear on opt-in repos within 60s of merge.
- [ ] At least one team lead reacts positively unprompted.
- [ ] Cost-per-PR numbers reconcile with `Session.cost_usd` sums.
- [ ] Zero PR comments posted to non-opted-in repos (manual + automated check).

## Risks

- GHES webhook payload variation; mitigate by version-detecting in `packages/github`.
- Installation tokens have 1-hour TTL — refresh transparently.
- PR comments are public; redaction failures here are louder than transcripts. Comment format is hand-built strings, no transcript content, just numbers — keep it that way.
