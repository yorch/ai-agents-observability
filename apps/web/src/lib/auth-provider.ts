import { GitHubProvider } from '@ai-agents-observability/auth';

export const provider = new GitHubProvider({
  clientId: process.env.GITHUB_OAUTH_CLIENT_ID!,
  clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET!,
});
