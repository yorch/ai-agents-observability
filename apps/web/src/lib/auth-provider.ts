import { GitHubProvider } from '@ai-agents-observability/auth';

import { requireEnv } from './env.js';

export const provider = new GitHubProvider({
  clientId: requireEnv('GITHUB_OAUTH_CLIENT_ID'),
  clientSecret: requireEnv('GITHUB_OAUTH_CLIENT_SECRET'),
});
