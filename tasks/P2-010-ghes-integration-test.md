---
id: P2-010
title: GHES integration test for webhook + bot flows
phase: 2
workstream: F
status: review
owner: null
depends_on: [P2-003, P2-006]
blocks: []
estimate: M
---

## Goal

Verify that the webhook handler and PR bot work identically against GitHub Enterprise Server (GHES). The test targets either a real GHES instance or a payload corpus recorded from one.

## Context

- `PLAN.md` §6 risks — "GHES webhook payload drift; mitigate by version-detecting in `packages/github`."
- `DESIGN_DOC.md` §7 — `GITHUB_HOST` env var controls github.com vs GHES.
- GHES webhook payloads differ from github.com in subtle ways: `html_url` domain, occasional missing fields on older versions, `installation.id` presence may vary.
- The `packages/github` client already handles GHES API URL routing. This task validates the webhook layer.

## Acceptance criteria

- [ ] A `apps/github-app/test/fixtures/ghes/` directory with recorded GHES webhook payloads for:
  - `pull_request.opened`
  - `pull_request.synchronize`
  - `pull_request.closed` (merged)
  Payloads sanitized of real org/user data (replace with `acme-corp`, `test-user`, etc.).
- [ ] Integration test `apps/github-app/test/ghes.integration.test.ts` that feeds each fixture payload through the full handler stack (signature → parse → PR upsert) and asserts:
  - No uncaught errors.
  - `PullRequest` row upserted correctly.
  - `html_url` domain in payload does not affect DB writes (only `owner/name` matter).
- [ ] If a real GHES instance is available (controlled via `GHES_TEST_HOST` env), the test also fires a live webhook and checks the DB. Otherwise it runs in fixture-only mode (always passes in CI).
- [ ] `packages/github/src/helpers.ts` extended with `getPRDetails(client, owner, repo, prNumber)` returning `{ title, linesAdded, linesRemoved, filesChanged, reviewCount }`. Test against both github.com and GHES fixture responses.
- [ ] Any GHES-specific payload normalizations documented in `packages/github/README.md`.

## Implementation notes

- To obtain GHES fixture payloads: use `smee.io` or `ngrok` to capture real deliveries from a GHES sandbox. Sanitize before committing.
- If no GHES access: build payloads manually from the GHES 3.x webhook API docs. The critical differences to cover: `html_url` has the GHES host, `installation` key may be absent on GHES < 3.6.
- `GHES_TEST_HOST` is optional; CI runs without it. Gate the live-webhook section with `if (process.env.GHES_TEST_HOST)`.
- Signature verification uses the same HMAC-SHA256 logic regardless of host — no special casing needed there.

## Files touched

- `apps/github-app/test/fixtures/ghes/pull_request.opened.json`
- `apps/github-app/test/fixtures/ghes/pull_request.synchronize.json`
- `apps/github-app/test/fixtures/ghes/pull_request.closed.merged.json`
- `apps/github-app/test/ghes.integration.test.ts` (new)
- `packages/github/src/helpers.ts` (add `getPRDetails`)
- `packages/github/src/index.ts` (re-export)
- `packages/github/README.md` (new — document GHES normalizations)
- `packages/github/test/helpers.test.ts` (update)

## Out of scope

- Testing `push` event payloads (Phase 4 commit correlation).
- GHES `checks` API differences (Phase 5).
- Automated GHES sandbox provisioning in CI (too expensive for Phase 2; manual fixture approach is sufficient).

## Verification

```bash
bun --filter '@ai-agents-observability/github-app' test
bun --filter '@ai-agents-observability/github' test

# With GHES access:
GHES_TEST_HOST=https://github.example.com bun --filter '@ai-agents-observability/github-app' test
```
