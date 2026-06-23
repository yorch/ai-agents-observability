import { randomBytes } from 'node:crypto';
import { createGitHubClient, getAuthenticatedUserTeams } from '@ai-agents-observability/github';
import { getGitHubHost, getOAuthBase } from './github-host';
import type { ExternalIdentity, IdentityProvider, TeamMembership } from './provider';

function generateState(): string {
  return randomBytes(32).toString('hex');
}

export class GitHubProvider implements IdentityProvider {
  readonly name = 'github';

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetch: typeof globalThis.fetch | undefined;

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

  async completeAuthorize(params: {
    code: string;
    redirectUri: string;
    state: string;
  }): Promise<ExternalIdentity> {
    const host = getGitHubHost();
    const base = getOAuthBase(host);
    const tokenRes = await (this.fetch ?? fetch)(`${base}/login/oauth/access_token`, {
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
      }),
      headers: { Accept: 'application/json' },
      method: 'POST',
    });
    if (!tokenRes.ok) {
      throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
    }
    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody.access_token) {
      throw new Error(`GitHub OAuth error: ${tokenBody.error ?? 'no token'}`);
    }

    const client = createGitHubClient({
      host,
      token: tokenBody.access_token,
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
      // `access_token` is stashed transiently so `fetchTeams` can call the GitHub
      // API on the caller's behalf during the same login request. It is never
      // persisted — the OAuth callback consumes it in-memory and discards it.
      raw: {
        access_token: tokenBody.access_token,
        avatar_url: ghUser.avatar_url,
        id: ghUser.id,
        login: ghUser.login,
      },
    };
  }

  async fetchTeams(identity: ExternalIdentity): Promise<TeamMembership[]> {
    const token = (identity.raw as { access_token?: string }).access_token;
    if (!token) {
      return [];
    }
    const host = getGitHubHost();
    const client = createGitHubClient({
      host,
      token,
      ...(this.fetch ? { fetch: this.fetch } : {}),
    });
    const teams = await getAuthenticatedUserTeams(client);
    return teams.map((t) => ({
      org: t.orgLogin,
      role: t.role,
      team_github_id: t.id,
      team_name: t.name,
      team_slug: t.slug,
    }));
  }
}
