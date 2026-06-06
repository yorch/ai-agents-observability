---
id: P1-017
title: Device-code flow for hook
phase: 1
workstream: C
status: done
owner: null
depends_on: [P1-014, P1-015]
blocks: [P1-023]
estimate: M
---

## Goal

`claude-telemetry login` (the hook binary subcommand) authenticates the local machine without a browser callback. After completion, the binary holds a `kind=hook` token that ingest will accept.

## Context

- GitHub supports the OAuth device-code flow natively (both github.com and GHES).
- The web app mediates: hook talks to web, web talks to GitHub. This way the hook never holds an OAuth client secret.

## Acceptance criteria

- [ ] Web endpoint `POST /api/auth/device/start` returns `{ device_code, user_code, verification_uri, interval, expires_in }`. Internally calls GitHub's device-code start.
- [ ] Web endpoint `POST /api/auth/device/poll` accepts `{ device_code }`, polls GitHub, and on success issues a `kind=hook` token via `issueHookToken`. Returns `{ status: 'pending' | 'authorized', hook_token? }`.
- [ ] Rate limit poll endpoint to honor the `interval` returned by GitHub (default 5s).
- [ ] Hook binary (P1-023 wires it up) calls `device/start`, prints the user code + URL, polls `device/poll` until authorized or expired.
- [ ] Hook stores the token in OS keychain (libsecret/Keychain/Credential Manager) — fallback to `~/.claude-telemetry/token` 0600 if keychain unavailable.
- [ ] Web also writes an `AuditLog` row: `action=hook_token_issued`, `subject_user_id=<user>`.
- [ ] Integration test mocks GitHub device-code endpoints and verifies the full flow yields a usable hook token.

## Implementation notes

- The `expires_in` from GitHub is typically 15 minutes — give the user that long.
- Don't return a refresh token to the hook; the hook token is renewed by re-running `login`.
- For keychain access, use `keytar` or platform-native bindings; abstract behind `packages/auth/src/keychain.ts` so the hook can swap easily.

## Files touched

- `apps/web/src/app/api/auth/device/start/route.ts`
- `apps/web/src/app/api/auth/device/poll/route.ts`
- `packages/auth/src/device-code.ts`
- `packages/auth/src/keychain.ts`
- `packages/auth/test/device-code.test.ts`

## Out of scope

- Hook binary CLI wiring (P1-023).
- Multi-account support on one machine.

## Verification

```bash
bun --filter '@pkg/auth' test
bun --filter '@app/web' test
# Manual:
# curl -sX POST http://localhost:3000/api/auth/device/start | jq .
# Open verification_uri in browser, enter user_code, poll until 'authorized'.
```
