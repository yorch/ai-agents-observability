import { randomBytes } from 'node:crypto';
import { createGitHubClient } from '@ai-agents-observability/github';
import { getGitHubHost, getOAuthBase } from './github-host.js';
import type { ExternalIdentity, IdentityProvider, TeamMembership } from './provider.js';

function generateState(): string {
  return randomBytes(32).toString('hex');
}

export class GitHubProvider implements IdentityProvider {
  readonly name = 'github';

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetch?: typeof globalThis.fetch;

  constructor(opts: { clientId: string; clientSecret: string; fetch?: typeof globalThis.fetch }) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetch = opts.fetch;
  }

  async startAuthorize(redirectUri: string): Promise<{ state: string; url: string }> {
    const host = getGitHubHost();
    const base = getOAuthBase(host);
    const state = generateState();
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user read:org user:email',
      state,
    });
    return { state, url: `${base}/login/oauth/authorize?${params}` };
  }

  async completeAuthorize(params: { code: string; state: string }): Promise<ExternalIdentity> {
    const host = getGitHubHost();
    const base = getOAuthBase(host);
    const tokenRes = await (this.fetch ?? fetch)(`${base}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: params.code,
      }),
    });
    if (!tokenRes.ok) throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody.access_token) throw new Error(`GitHub OAuth error: ${tokenBody.error ?? 'no token'}`);

    const client = createGitHubClient({
      token: tokenBody.access_token,
      host,
      ...(this.fetch ? { fetch: this.fetch } : {}),
    });
    const { data: ghUser } = await client.rest.users.getAuthenticated();

    let email: string | null = ghUser.email ?? null;
    if (!email) {
      try {
        const { data: emails } = await client.rest.users.listEmailsForAuthenticatedUser();
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email ?? null;
      } catch {
        // non-fatal
      }
    }

    return {
      display_name: ghUser.name ?? ghUser.login,
      email,
      external_id: String(ghUser.id),
      provider_name: 'github',
      raw: { login: ghUser.login, avatar_url: ghUser.avatar_url, id: ghUser.id },
    };
  }

  async fetchTeams(_identity: ExternalIdentity): Promise<TeamMembership[]> {
    return [];
  }
}
