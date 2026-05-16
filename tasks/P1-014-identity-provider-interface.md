---
id: P1-014
title: IdentityProvider interface + JWT issuance
phase: 1
workstream: C
status: ready
owner: null
depends_on: [P1-001]
blocks: [P1-009, P1-016, P1-017]
estimate: M
---

## Goal

`packages/auth` defines an `IdentityProvider` interface plus a JWT/refresh-token issuance layer that all auth flows feed into. Future SSO providers (Okta, Azure) drop in by implementing the same interface — no caller-side changes.

## Context

- `PLAN.md` §1 commits to the SSO seam.
- Tokens stored hashed in `AuthToken` (P1-003 model). The package owns the read/write of that table.
- Three token kinds: `access` (15min JWT), `refresh` (long-lived opaque), `hook` (very long-lived opaque, scoped to events/transcripts ingest only).

## Acceptance criteria

- [ ] `IdentityProvider` interface in `packages/auth/src/provider.ts`:
  ```ts
  interface IdentityProvider {
    name: string;
    startAuthorize(redirect_uri: string): Promise<{ url: string; state: string }>;
    completeAuthorize(params: { code: string; state: string }): Promise<ExternalIdentity>;
    fetchTeams(identity: ExternalIdentity): Promise<TeamMembership[]>;
  }
  ```
- [ ] `ExternalIdentity` shape: `{ external_id, email, display_name, provider_name, raw }`.
- [ ] `issueAccessToken(user_id)` mints a JWT (RS256, 15min, payload `{ sub, kind: 'access', iat, exp, jti }`).
- [ ] `issueRefreshToken(user_id)` mints an opaque token, stores SHA-256 hash in `AuthToken`, returns plaintext.
- [ ] `issueHookToken(user_id)` same as refresh but `kind=hook`, expiry 1 year.
- [ ] `verifyAccessToken(jwt)` returns `{ user_id }` or throws.
- [ ] `verifyOpaqueToken(token)` looks up hash in `AuthToken`, checks expiry/revocation, returns `{ user_id, kind }` or throws.
- [ ] `revokeToken(id)` sets `revoked_at`.
- [ ] `rotateRefreshToken(refresh)` atomically issues new refresh + access, revokes old.
- [ ] RSA keypair: read from `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` env (PEM). Document key rotation in README.
- [ ] Tests cover happy path + every failure mode (expired, revoked, malformed, wrong kind).

## Implementation notes

- Use `jose` for JWT. Don't roll your own.
- Token format on the wire: JWTs are JWTs; opaque tokens are `cct_<32 base32 chars>` so they're visually distinct.
- Keep the GitHub provider in a *separate* file (P1-016 implements it). This task ships the interface and a NoopProvider stub for testing.

## Files touched

- `packages/auth/src/provider.ts`
- `packages/auth/src/tokens.ts`
- `packages/auth/src/keys.ts`
- `packages/auth/src/noop-provider.ts` (test double)
- `packages/auth/test/tokens.test.ts`

## Out of scope

- GitHub OAuth (P1-016).
- Device-code flow (P1-017).
- SCIM / directory sync.

## Verification

```bash
pnpm --filter=@pkg/auth test
```
