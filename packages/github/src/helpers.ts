import type { GitHubClient } from './client.js';
import type { RepoSummary, TeamSummary, UserSummary } from './types.js';

export async function getCurrentUser(client: GitHubClient): Promise<UserSummary> {
  const { data } = await client.rest.users.getAuthenticated();
  return {
    email: data.email ?? null,
    id: data.id,
    login: data.login,
    name: data.name ?? null,
  };
}

export async function getOrgTeams(client: GitHubClient, org: string): Promise<TeamSummary[]> {
  const { data } = await client.rest.teams.list({ org, per_page: 100 });
  return data.map((t) => ({
    description: t.description ?? null,
    id: t.id,
    members_count: 0,
    name: t.name,
    slug: t.slug,
  }));
}

export async function getTeamMembers(
  client: GitHubClient,
  org: string,
  team_slug: string,
): Promise<UserSummary[]> {
  const { data } = await client.rest.teams.listMembersInOrg({ org, per_page: 100, team_slug });
  return data.map((m) => ({
    email: null,
    id: m.id,
    login: m.login,
    name: m.name ?? null,
  }));
}

export async function getRepo(
  client: GitHubClient,
  owner: string,
  name: string,
): Promise<RepoSummary> {
  const { data } = await client.rest.repos.get({ owner, repo: name });
  return {
    default_branch: data.default_branch,
    full_name: data.full_name,
    id: data.id,
    is_private: data.private,
    name: data.name,
    owner: data.owner.login,
    url: data.html_url,
  };
}
