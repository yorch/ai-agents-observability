---
id: P2-002
title: apps/github-app webhook handler service
phase: 2
workstream: B
status: review
owner: null
depends_on: [P2-001]
blocks: [P2-003, P2-009]
estimate: M
---

## Goal

A new `apps/github-app` Bun + Hono service receives GitHub webhook deliveries, validates their HMAC-SHA256 signature, and routes by event type. Mirrors the operational shape of `apps/ingest`.

## Context

- `DESIGN_DOC.md` §7.2 — receives `pull_request`, `push`, `installation` events.
- `PLAN.md` §2 repo layout — `apps/github-app/` is the Phase 2 webhook handler.
- `@octokit/webhooks` 14.1.0 is already in the catalog; use it for signature verification and typed event payloads.
- Port: 4001 (ingest is 4000, web is 3000).

## Acceptance criteria

- [ ] `apps/github-app` package exists with `package.json` (`name: @ai-agents-observability/github-app`), `tsconfig.json`, and standard scripts (`dev`, `build`, `typecheck`, `test`).
- [ ] `GET /health` returns `{ status: "ok", version: "<GIT_SHA>" }` — same contract as ingest.
- [ ] `POST /webhooks/github`:
  - Verifies `X-Hub-Signature-256` using `GITHUB_APP_WEBHOOK_SECRET` via `@octokit/webhooks`. Returns 401 on invalid signature.
  - Returns 400 on missing or malformed `X-GitHub-Event` header.
  - Returns 202 immediately after signature verification; dispatches to event-type handlers asynchronously.
  - Logs each delivery: `{ event, delivery_id, repo, action }` at info level via pino.
- [ ] Handlers are registered as a router of async functions keyed by `event_type:action` — e.g. `pull_request:opened`. Unknown event/action combinations are silently acked (202, no error).
- [ ] `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (base64-encoded PEM), and `GITHUB_APP_WEBHOOK_SECRET` loaded from env at startup; service refuses to start if any are absent.
- [ ] `apps/github-app/Dockerfile` (Bun base image) added.
- [ ] `infra/docker-compose.yml` gets a `github-app` service entry (disabled by default with a profile: `["pr-loop"]` so the base stack doesn't change).
- [ ] `GITHUB_APP_PORT` added to `.env.example` (default 4001).
- [ ] Test: POST with correct signature → 202; POST with wrong signature → 401; POST with unknown event → 202.

## Implementation notes

- Use `@octokit/webhooks` `Webhooks` class: `new Webhooks({ secret })`. Call `webhooks.verifyAndReceive({ id, name, signature, payload })`. This handles both signature verification and typed dispatch in one step.
- For async dispatch: `webhooks.on('pull_request', handler)`. The 202 response is sent before the handler resolves — keep handlers fast (queue work; don't do heavy DB writes inline).
- App private key decoding: `Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY, 'base64').toString('utf-8')`.
- Installation token generation is NOT in this task — covered in P2-006.
- Follow `apps/ingest` for: pino logger setup, request-id middleware, Biome config, test setup.

## Files touched

- `apps/github-app/package.json`
- `apps/github-app/tsconfig.json`
- `apps/github-app/src/index.ts`
- `apps/github-app/src/app.ts`
- `apps/github-app/src/config.ts`
- `apps/github-app/src/middleware/signature.ts`
- `apps/github-app/src/middleware/request-id.ts`
- `apps/github-app/src/middleware/logger.ts`
- `apps/github-app/src/routes/webhooks.ts`
- `apps/github-app/src/routes/health.ts`
- `apps/github-app/src/types.ts`
- `apps/github-app/Dockerfile`
- `apps/github-app/test/webhooks.test.ts`
- `infra/docker-compose.yml`
- `.env.example`

## Out of scope

- Actual PR/push event handling (P2-003).
- Installation token fetch (P2-006).
- Health metrics dashboard (P2-009).

## Verification

```bash
bun --filter '@ai-agents-observability/github-app' dev
curl http://localhost:4001/health

# Correct signature (test helper generates one):
bun --filter '@ai-agents-observability/github-app' test
```
