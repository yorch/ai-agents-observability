import type { GitHubClient } from './client';
import type { RepoSummary, TeamSummary, UserSummary, UserTeamSummary } from './types';

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
  const teams = await client.paginate(client.rest.teams.list, { org, per_page: 100 });
  return teams.map((t) => ({
    description: t.description ?? null,
    id: t.id,
    // members_count is present in the API response but absent from Octokit's list types
    members_count: (t as typeof t & { members_count?: number }).members_count ?? 0,
    name: t.name,
    slug: t.slug,
  }));
}

export async function getTeamMembers(
  client: GitHubClient,
  org: string,
  team_slug: string,
): Promise<UserSummary[]> {
  const members = await client.paginate(client.rest.teams.listMembersInOrg, {
    org,
    per_page: 100,
    team_slug,
  });
  return members.map((m) => ({
    email: null,
    id: m.id,
    login: m.login,
    name: m.name ?? null,
  }));
}

/**
 * Lists every team the authenticated user belongs to, across all of their orgs,
 * via `GET /user/teams`. Requires the `read:org` scope (which the web OAuth flow
 * requests). The endpoint does not report the caller's role within each team, so
 * membership is recorded as `member`.
 */
export async function getAuthenticatedUserTeams(client: GitHubClient): Promise<UserTeamSummary[]> {
  const teams = await client.paginate(client.rest.teams.listForAuthenticatedUser, {
    per_page: 100,
  });
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    orgLogin: t.organization.login,
    role: 'member' as const,
    slug: t.slug,
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

export async function getPRDetails(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{
  title: string;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  reviewCount: number;
} | null> {
  try {
    const { data } = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      pull_number: prNumber,
      repo,
    });
    const reviews = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      owner,
      pull_number: prNumber,
      repo,
    });
    return {
      filesChanged: data.changed_files,
      linesAdded: data.additions,
      linesRemoved: data.deletions,
      reviewCount: reviews.data.length,
      title: data.title,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a webhook `repository.full_name` ("owner/name") into its segments.
 * Returns null on anything malformed (missing slash, empty segment, extra
 * segments) so callers can skip/log instead of writing garbage rows.
 */
export function parseRepoFullName(fullName: string): { name: string; owner: string } | null {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { name: parts[1], owner: parts[0] };
}

/**
 * List the commit SHAs belonging to a PR. Best-effort: returns [] on any
 * error — SHA matching is an enhancement on top of branch-name matching,
 * never a reason to fail a webhook. Bounded at 300 commits; PRs beyond that
 * are extreme outliers and their sessions still link by branch name.
 */
export async function listPRCommitShas(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  const MAX_COMMITS = 300;
  try {
    let fetched = 0;
    const commits = await client.paginate(
      client.rest.pulls.listCommits,
      { owner, per_page: 100, pull_number: prNumber, repo },
      (response, done) => {
        fetched += response.data.length;
        // Stop paginating at the cap — don't walk a 5000-commit PR.
        if (fetched >= MAX_COMMITS) {
          done();
        }
        return response.data;
      },
    );
    return commits.slice(0, MAX_COMMITS).map((c) => c.sha);
  } catch {
    return [];
  }
}
