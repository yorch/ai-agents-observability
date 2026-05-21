import { GitHubProvider } from '@ai-agents-observability/auth';

import { requireEnv } from './env';

// Lazy singleton — see lib/prisma.ts for the same pattern. Reads OAuth env
// only on first call so route modules import cleanly during Next's build-time
// static analysis.
let cached: GitHubProvider | undefined;

export function getProvider(): GitHubProvider {
  if (!cached) {
    cached = new GitHubProvider({
      clientId: requireEnv('GITHUB_OAUTH_CLIENT_ID'),
      clientSecret: requireEnv('GITHUB_OAUTH_CLIENT_SECRET'),
    });
  }
  return cached;
}
