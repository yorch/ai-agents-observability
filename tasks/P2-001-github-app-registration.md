---
id: P2-001
title: GitHub App registration + credentials wiring
phase: 2
workstream: A
status: review
owner: null
depends_on: []
blocks: [P2-002, P2-007]
estimate: S
---

## Goal

A GitHub App exists (github.com or GHES) with the correct permissions and webhook subscriptions. Its credentials are wired into the project via `.env.example` and documented so any developer can reproduce the registration.

## Context

- `DESIGN_DOC.md` §7.2 and §7.5 — the GitHub App is separate from the OAuth App. It uses installation tokens (not user tokens) so automated PR comments are not "as a user".
- `PLAN.md` §1 — `GITHUB_HOST` env var controls github.com vs GHES.
- This task is partly manual (clicking through GitHub's App registration UI). Document the steps so a second person can replicate them.

## Acceptance criteria

- [ ] GitHub App registered with:
  - **Permissions** (repository): `pull_requests: read`, `contents: read`, `checks: read`, `metadata: read`
  - **Permissions** (organization): `members: read`
  - **Subscribe to events**: `pull_request`, `push`, `installation`, `installation_repositories`
  - Webhook URL: set to `https://<your-host>/webhooks/github` (can be a placeholder during local dev; use smee.io or ngrok for testing)
- [ ] App private key downloaded as PEM; stored as `GITHUB_APP_PRIVATE_KEY` (base64-encoded single line) in `.env`.
- [ ] App ID stored as `GITHUB_APP_ID`.
- [ ] Webhook secret generated (`openssl rand -hex 32`) and stored as `GITHUB_APP_WEBHOOK_SECRET`.
- [ ] `.env.example` updated with all three new variables (commented out, with description).
- [ ] `docs/github-app-setup.md` created: step-by-step registration guide covering both github.com and GHES, including the smee.io proxy setup for local webhook development.
- [ ] App is installed on at least one test repo so P2-002 can receive live webhooks.

## Implementation notes

- For GHES: use `https://<GITHUB_HOST>/organizations/<org>/settings/apps/new`. The rest is identical.
- Base64-encode the private key for the env var: `base64 -w0 private-key.pem` (Linux) or `base64 -i private-key.pem` (Mac). Decode in code with `Buffer.from(key, 'base64').toString()`.
- Smee.io proxy for local dev: `npx smee-client --url https://smee.io/<channel> --path /webhooks/github --port 4001`. Document this in the setup guide.
- The App does **not** need write permissions to the repo — only `pull_requests: write` is needed to post comments. Add that to the permission list above.

**Correction**: Add `pull_requests: write` to the permissions list above. Without it the bot cannot post merge comments (P2-006).

## Files touched

- `.env.example` (add `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`)
- `docs/github-app-setup.md` (new)

## Out of scope

- Webhook handler code (P2-002).
- Installation token refresh logic (P2-002 / P2-006).

## Verification

```bash
# Confirm env vars are documented
grep GITHUB_APP .env.example

# Confirm setup doc exists
cat docs/github-app-setup.md

# Manual: trigger a test webhook delivery from the GitHub App settings page
# and confirm it reaches the smee.io proxy.
```
