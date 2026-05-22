import type { ExternalIdentity, IdentityProvider, TeamMembership } from './provider';

/** Test double that returns configurable canned responses. */
export class NoopProvider implements IdentityProvider {
  readonly name = 'noop';

  private readonly identity: ExternalIdentity;
  private readonly teams: TeamMembership[];

  constructor(
    identity: ExternalIdentity = {
      display_name: 'Test User',
      email: 'test@example.com',
      external_id: 'noop:test-user',
      provider_name: 'noop',
      raw: {},
    },
    teams: TeamMembership[] = [],
  ) {
    this.identity = identity;
    this.teams = teams;
  }

  async startAuthorize(_redirect_uri: string): Promise<{ state: string; url: string }> {
    return { state: 'noop-state', url: 'https://example.com/auth?state=noop-state' };
  }

  async completeAuthorize(_params: { code: string; state: string }): Promise<ExternalIdentity> {
    return this.identity;
  }

  async fetchTeams(_identity: ExternalIdentity): Promise<TeamMembership[]> {
    return this.teams;
  }
}
