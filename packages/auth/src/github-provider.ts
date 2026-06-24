import { randomBytes } from 'node:crypto';
import {
  createGitHubClient,
  type GitHubClient,
  getAuthenticatedUserTeams,
} from '@ai-agents-observability/github';
import { getGitHubHost, getOAuthBase } from './github-host';
import type { ExternalIdentity, IdentityProvider, TeamMembership } from './provider';

function generateState(): string {
  return randomBytes(32).toString('hex');
}

// Associates a freshly-issued identity with its OAuth access token WITHOUT
// exposing the secret as an enumerable property of `ExternalIdentity` (which
// could leak if the identity is ever logged or serialized). The entry lives only
// as long as the identity object the login flow holds, then is garbage-collected.
const accessTokenByIdentity = new WeakMap<ExternalIdentity, string>();

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

    const client = this.clientFor(tokenBody.access_token);
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

    const identity: ExternalIdentity = {
      display_name: ghUser.name ?? ghUser.login,
      email,
      external_id: String(ghUser.id),
      provider_name: 'github',
      raw: { avatar_url: ghUser.avatar_url, id: ghUser.id, login: ghUser.login },
    };
    // Stash the token off-band so `fetchTeams` can call GitHub during the same
    // login request without the secret riding along on the storable identity.
    accessTokenByIdentity.set(identity, tokenBody.access_token);
    return identity;
  }

  // Build an Octokit client for the configured host, carrying the optional fetch
  // override. Shared by completeAuthorize and fetchTeams.
  private clientFor(token: string): GitHubClient {
    return createGitHubClient({
      host: getGitHubHost(),
      token,
      ...(this.fetch ? { fetch: this.fetch } : {}),
    });
  }

  async fetchTeams(identity: ExternalIdentity): Promise<TeamMembership[]> {
    const token = accessTokenByIdentity.get(identity);
    if (!token) {
      return [];
    }
    const client = this.clientFor(token);
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
