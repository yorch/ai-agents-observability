---
id: P2-006
title: PR bot merge-summary comment
phase: 2
workstream: B
status: review
owner: null
depends_on: [P2-005, P2-007]
blocks: [P2-010]
estimate: M
---

## Goal

When a PR merges on an opted-in repo, the GitHub App posts a summary comment. The comment contains only aggregated numbers — no transcript content, no raw prompt text. Opt-in is per-repo via `.claude-telemetry.yml`.

## Context

- `DESIGN_DOC.md` §7.4 — comment format defined there.
- `DESIGN_DOC.md` §7.5 — uses the GitHub App installation token, not a user token.
- `PLAN.md` §2 risks — "PR comments are public; comment format is hand-built strings, no transcript content, just numbers — keep it that way."
- P2-007 provides `parseRepoConfig` which reads `.claude-telemetry.yml` and returns whether bot comments are enabled.

## Acceptance criteria

- [ ] After rollup is computed (P2-005), check if the repo opts in:
  1. Fetch the file `/.claude-telemetry.yml` from the merge commit's tree via GitHub API (contents endpoint). Use the App installation token.
  2. Parse with `parseRepoConfig` (P2-007). If `pr_bot.enabled != true` (or file absent), skip — do NOT post.
  3. If opted in, post a comment to the PR.
- [ ] Comment format (exact):
  ```
  🤖 **Claude Code summary**
  • N sessions · M contributors
  • $X.XX total cost · Y tool calls
  • Top tools: ToolA (n), ToolB (n), ToolC (n)
  • Time span: Hh Mm (first session → merge)
  ```
  "Top tools" line is omitted if no tool call data. "Time span" is omitted if `total_active_seconds` is null.
- [ ] Uses GitHub App installation token (not the OAuth user token). Fetched via `POST /app/installations/{id}/access_tokens` with the App JWT.
- [ ] App JWT generated from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` using `@octokit/auth-app` or manual JWT (exp: 10 minutes, iat: now - 60s to account for clock skew). See implementation notes.
- [ ] Installation token is cached in memory per `installation_id` with a 55-minute TTL (tokens expire at 60 min).
- [ ] If posting the comment fails (GitHub API error), log the error at warn level and continue — a failed bot comment must not break the merge handler.
- [ ] Test: mock GitHub API; assert comment body matches format for a known rollup; assert no comment posted when opted out.

## Implementation notes

- `@octokit/auth-app` is not in the catalog yet — add `"@octokit/auth-app": "7.1.1"` to the root catalog. Alternatively, build the App JWT manually with `jose` (already in catalog). The App JWT is a short RS256 JWT signed with the private key.
- App JWT payload: `{ iss: APP_ID, iat: Math.floor(Date.now()/1000) - 60, exp: Math.floor(Date.now()/1000) + 540 }`.
- Sign with `jose`'s `new SignJWT(payload).setProtectedHeader({ alg: 'RS256' }).sign(privateKey)`.
- Get `installation_id` from the webhook payload: `payload.installation.id`.
- Comment API: `POST /repos/{owner}/{repo}/issues/{pr_number}/comments` with the installation token. Use `createGitHubClient` from `packages/github` with the installation token.
- "Top tools" computation: the `PRRollup` model doesn't store per-tool breakdown (see P1-011 as-built deviation). For the top-tools line, either (a) query the `events` hypertable for the linked sessions, or (b) omit the line for v1. **Option (b) is the pragmatic choice.** Document it and add a follow-up task.

## Files touched

- `apps/github-app/src/lib/installation-token.ts` (new: JWT + token cache)
- `apps/github-app/src/lib/pr-comment.ts` (new: comment formatting + posting)
- `apps/github-app/src/handlers/pull-request.ts` (call bot after rollup)
- `apps/github-app/test/pr-comment.test.ts` (new)
- `package.json` (add `@octokit/auth-app` to catalog if using it)

## Out of scope

- Per-user masking preferences from `.claude-telemetry.yml` (Phase 3).
- "Top tools" from event data (deferred — see implementation note).
- Re-posting / updating comments if rollup is recomputed (Phase 4).

## Verification

```bash
bun --filter '@ai-agents-observability/github-app' test

# Manual: merge a PR on an opted-in repo; confirm comment appears within 60s.
# Merge a PR on a non-opted-in repo; confirm no comment.
```
