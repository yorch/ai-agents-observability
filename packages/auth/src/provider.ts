export type ExternalIdentity = {
  display_name: string;
  email: string | null;
  external_id: string;
  provider_name: string;
  raw: Record<string, unknown>;
};

export type TeamMembership = {
  org: string;
  role: 'member' | 'maintainer';
  team_slug: string;
};

export interface IdentityProvider {
  completeAuthorize(params: { code: string; state: string }): Promise<ExternalIdentity>;
  fetchTeams(identity: ExternalIdentity): Promise<TeamMembership[]>;
  name: string;
  startAuthorize(redirect_uri: string): Promise<{ state: string; url: string }>;
}
