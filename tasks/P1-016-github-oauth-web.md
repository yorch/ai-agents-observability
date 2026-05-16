---
id: P1-016
title: GitHub OAuth (web flow)
phase: 1
workstream: C
status: blocked
owner: null
depends_on: [P1-014, P1-015]
blocks: [P1-024]
estimate: M
---

## Goal

The web app can log a user in via GitHub OAuth. On first login, a `User` row is created; subsequent logins resolve to the same user. Works against both github.com and GHES.

## Context

- Implements `IdentityProvider` from P1-014.
- `DESIGN_DOC.md` §11 ties trust to "this is YOUR data" — getting the user-to-row binding right is foundational.

## Acceptance criteria

- [ ] `GitHubProvider` class implements `IdentityProvider`:
  - `startAuthorize` builds the authorize URL with `state` (CSRF) and `scope=read:user read:org user:email`.
  - `completeAuthorize` exchanges code for token, fetches `/user` and `/user/emails`, returns `ExternalIdentity`.
  - `fetchTeams` calls `getOrgTeams` for each org the user belongs to.
- [ ] Web app routes (Next.js Route Handlers):
  - `GET /api/auth/login` → 302 to provider authorize URL, sets state cookie.
  - `GET /api/auth/callback` → completes flow, upserts `User` + `TeamMember` rows, issues access + refresh, sets HTTP-only cookies, redirects to `/me`.
  - `POST /api/auth/logout` → revokes refresh token, clears cookies, 204.
- [ ] State cookie HTTPOnly, Secure (in prod), SameSite=Lax, 10min expiry.
- [ ] Access token: HTTPOnly cookie. Refresh: HTTPOnly cookie, path `/api/auth/refresh` only.
- [ ] `POST /api/auth/refresh` rotates tokens (calls `rotateRefreshToken`).
- [ ] If `GITHUB_HOST` is set, all URLs build off that host (web user-facing auth UI tells the user which host they're authing against).
- [ ] Integration test using mocked GitHub endpoints: full login flow creates user + team memberships, login again resolves to same user, logout revokes.

## Implementation notes

- Don't put the refresh token in localStorage. Cookies only.
- `state` must be bound to the cookie — store a hash of the state in a cookie, send the raw state in the URL, validate on callback.
- For GHES, the OAuth app credentials are different per host — env vars: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`. Configurable per deploy.

## Files touched

- `packages/auth/src/github-provider.ts`
- `apps/web/src/app/api/auth/login/route.ts`
- `apps/web/src/app/api/auth/callback/route.ts`
- `apps/web/src/app/api/auth/logout/route.ts`
- `apps/web/src/app/api/auth/refresh/route.ts`
- `apps/web/src/lib/session-cookie.ts`
- `packages/auth/test/github-provider.test.ts`

## Out of scope

- Device-code flow (P1-017).
- Multi-org disambiguation UI (assume user picks one).

## Verification

```bash
pnpm --filter=@pkg/auth test
pnpm --filter=@app/web test
# Manual against a test GitHub OAuth app:
# Visit http://localhost:3000/api/auth/login → callback → see /me.
```
