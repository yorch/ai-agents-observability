---
id: P1-015
title: packages/github — host-agnostic Octokit
phase: 1
workstream: C
status: ready
owner: null
depends_on: [P1-001]
blocks: [P1-016, P1-017, P1-018]
estimate: S
---

## Goal

A thin wrapper around Octokit that transparently targets either github.com or GHES based on the `GITHUB_HOST` env var. Every other package that talks to GitHub goes through this.

## Context

- `PLAN.md` §1: must support both hosts.
- GHES API base is `<host>/api/v3`; github.com is `https://api.github.com`. The wrapper hides this difference.
- Also the home for retry/throttling plugins.

## Acceptance criteria

- [ ] `createGitHubClient({ token, host? })` returns an `Octokit` instance configured for the resolved host.
- [ ] If `host` argument absent, reads `GITHUB_HOST` env (default `https://github.com`).
- [ ] API base URL derived: `https://api.github.com` for github.com; `<host>/api/v3` for everything else.
- [ ] Retry plugin (`@octokit/plugin-retry`) + throttling plugin (`@octokit/plugin-throttling`) wired in.
- [ ] Helpers:
  - `getCurrentUser(client) → { id, login, email, name }`
  - `getOrgTeams(client, org) → TeamSummary[]`
  - `getTeamMembers(client, org, team_slug) → UserSummary[]`
  - `getRepo(client, owner, name) → RepoSummary`
- [ ] Type definitions for the helper return shapes — don't leak Octokit types into callers.
- [ ] Tests use `nock` (or `msw`) to mock both github.com and a fake GHES instance; assert the URL each call hits.

## Implementation notes

- Detect GHES via host check; don't require an extra "ghes" flag.
- Keep this layer thin — anti-pattern to grow it into a domain service.
- User-Agent header: `claude-telemetry/<version>`.

## Files touched

- `packages/github/src/client.ts`
- `packages/github/src/helpers.ts`
- `packages/github/src/types.ts`
- `packages/github/src/index.ts`
- `packages/github/test/client.test.ts`

## Out of scope

- GitHub App auth (Phase 2 webhook handler).
- Caching layer.

## Verification

```bash
pnpm --filter=@pkg/github test
```
