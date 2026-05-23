# @ai-agents-observability/github

Host-agnostic Octokit wrappers for github.com and GitHub Enterprise Server (GHES).

## Usage

```typescript
import { createGitHubClient, getCurrentUser, getPRDetails } from '@ai-agents-observability/github';

const client = createGitHubClient({ token, host: 'https://github.example.com' });
const user = await getCurrentUser(client);
const pr = await getPRDetails(client, 'owner', 'repo', 42);
```

## GHES compatibility notes

- API base URL is resolved automatically: `https://github.com` → `https://api.github.com`; any other host → `${host}/api/v3`
- The `@octokit/plugin-enterprise-compatibility` plugin is loaded for GHES hosts to handle endpoint path differences
- Webhook payloads from GHES differ from github.com in these ways:
  - `html_url` uses the GHES host domain — do not parse the domain from this field; use `repository.full_name` for owner/name
  - `installation` key may be `null` or absent on GHES < 3.6 — always guard with `payload.installation?.id`
  - Some older GHES versions omit `additions`/`deletions`/`changed_files` on `pull_request.opened` — treat as 0/null

## GHES_TEST_HOST

Set `GHES_TEST_HOST=https://your-ghes-host` to run live integration tests against a real GHES instance.
