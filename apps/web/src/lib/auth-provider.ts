import { GitHubProvider } from '@ai-agents-observability/auth';

import { getConfig } from '@/lib/config';

// Lazy singleton — only reads env on first call so route modules import cleanly
// during Next.js build-time static analysis.
let cached: GitHubProvider | undefined;

export function getProvider(): GitHubProvider {
  if (!cached) {
    const { githubOAuthClientId, githubOAuthClientSecret } = getConfig();
    if (!githubOAuthClientId || !githubOAuthClientSecret) {
      throw new Error('GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET must be set');
    }
    cached = new GitHubProvider({
      clientId: githubOAuthClientId,
      clientSecret: githubOAuthClientSecret,
    });
  }
  return cached;
}
