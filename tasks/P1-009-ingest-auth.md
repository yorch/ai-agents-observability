---
id: P1-009
title: Ingest auth middleware + identity verification
phase: 1
workstream: B
status: blocked
owner: null
depends_on: [P1-008, P1-014]
blocks: [P1-010, P1-012]
estimate: M
---

## Goal

Every ingest endpoint requires a valid bearer token; the resolved `user_id` is attached to the request context. The middleware also implements the identity-claim verification in `DESIGN_DOC.md` §6.5: payload-asserted `user_id_claim` is compared to the token's user_id and mismatches are logged as `suspicious_identity_claim`.

## Context

- Tokens are issued by `packages/auth` (P1-014) and stored hashed in `AuthToken`.
- Hooks use a long-lived `kind=hook` token; web uses short-lived `kind=access` + refresh.
- The "claim, don't trust" model in §6.5 is the security backbone — get this right.

## Acceptance criteria

- [ ] `authRequired()` Hono middleware extracts `Authorization: Bearer <token>`; rejects 401 if missing/malformed.
- [ ] Token verified against `AuthToken` table (SHA-256 hash lookup); rejects 401 if not found, revoked, or expired.
- [ ] On success, attaches `c.set('user', { id, kind })` for downstream handlers.
- [ ] `verifyIdentityClaim(c, claim)` helper compares `c.get('user').id` to `claim`. On mismatch:
  - Log `event: 'suspicious_identity_claim'` with both IDs.
  - Override the claim with the token's user_id (never trust client claim).
  - Continue (don't 401) — this prevents a malicious client from blocking legitimate ingest.
- [ ] Rate-limit middleware in front of auth: 1000 req/min per IP, returns 429 with `Retry-After`.
- [ ] Test: valid token resolves user; invalid token 401s; mismatched claim logs warning + uses token id.

## Implementation notes

- Bearer token format: `cct_<32-char-base32>`. Hash with SHA-256, compare hex.
- Cache token lookups in-memory for 30s (LRU) — saves a DB hit per event batch.
- Rate limit storage: in-memory for v1 (single ingest instance). Phase 4 swaps to Redis when scaled out.

## Files touched

- `apps/ingest/src/middleware/auth.ts`
- `apps/ingest/src/middleware/rate-limit.ts`
- `apps/ingest/src/lib/identity.ts`
- `apps/ingest/test/auth.test.ts`

## Out of scope

- mTLS (deferred).
- Org-scoped tokens (Phase 3+).

## Verification

```bash
bun --filter '@app/ingest' test
# Manual:
curl -i http://localhost:4000/v1/events                              # 401
curl -i -H 'Authorization: Bearer bad' http://localhost:4000/v1/events  # 401
```
