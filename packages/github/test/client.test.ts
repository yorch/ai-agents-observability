import { describe, expect, it, vi } from 'vitest';

import { createGitHubClient } from '../src/client';
import { getCurrentUser, getOrgTeams, getRepo, getTeamMembers } from '../src/helpers';

// ── Mock fetch factory ────────────────────────────────────────────────────────

function makeFetch(responseBody: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(responseBody), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }),
  );
}

// ── URL routing ───────────────────────────────────────────────────────────────

describe('createGitHubClient — base URL routing', () => {
  it('uses api.github.com for the default host', async () => {
    const fetch = makeFetch({ email: null, id: 1, login: 'testuser', name: null });
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });
    await client.rest.users.getAuthenticated();

    expect(fetch).toHaveBeenCalledOnce();
    const [url] = fetch.mock.calls[0] as [string, unknown];
    expect(url).toMatch(/^https:\/\/api\.github\.com\//);
  });

  it('uses <host>/api/v3 for a GHES instance', async () => {
    const fetch = makeFetch({ email: null, id: 1, login: 'testuser', name: null });
    const client = createGitHubClient({
      fetch,
      host: 'https://github.example.com',
      token: 'ghs_test',
    });
    await client.rest.users.getAuthenticated();

    expect(fetch).toHaveBeenCalledOnce();
    const [url] = fetch.mock.calls[0] as [string, unknown];
    expect(url).toMatch(/^https:\/\/github\.example\.com\/api\/v3\//);
  });

  it('falls back to GITHUB_HOST env when host option is absent', async () => {
    process.env.GITHUB_HOST = 'https://github.myco.com';
    const fetch = makeFetch({ email: null, id: 1, login: 'testuser', name: null });
    const client = createGitHubClient({ fetch, token: 'ghs_test' });
    await client.rest.users.getAuthenticated();

    const [url] = fetch.mock.calls[0] as [string, unknown];
    expect(url).toMatch(/^https:\/\/github\.myco\.com\/api\/v3\//);
    delete process.env.GITHUB_HOST;
  });
});

// ── Helper: getCurrentUser ────────────────────────────────────────────────────

describe('getCurrentUser', () => {
  it('returns mapped UserSummary', async () => {
    const fetch = makeFetch({ email: 'j@example.com', id: 42, login: 'jorgef', name: 'Jorge F' });
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });

    const user = await getCurrentUser(client);
    expect(user).toEqual({ email: 'j@example.com', id: 42, login: 'jorgef', name: 'Jorge F' });
  });

  it('maps null name and email', async () => {
    const fetch = makeFetch({ email: null, id: 7, login: 'ghost', name: null });
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });

    const user = await getCurrentUser(client);
    expect(user.email).toBeNull();
    expect(user.name).toBeNull();
  });
});

// ── Helper: getOrgTeams ───────────────────────────────────────────────────────

describe('getOrgTeams', () => {
  it('returns mapped TeamSummary array', async () => {
    const fetch = makeFetch([
      { description: 'Backend team', id: 1, members_count: 5, name: 'backend', slug: 'backend' },
    ]);
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });

    const teams = await getOrgTeams(client, 'myorg');
    expect(teams).toHaveLength(1);
    expect(teams[0]).toEqual({
      description: 'Backend team',
      id: 1,
      members_count: 5,
      name: 'backend',
      slug: 'backend',
    });
  });
});

// ── Helper: getTeamMembers ────────────────────────────────────────────────────

describe('getTeamMembers', () => {
  it('returns mapped UserSummary array', async () => {
    const fetch = makeFetch([{ avatar_url: '', id: 10, login: 'alice', name: 'Alice' }]);
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });

    const members = await getTeamMembers(client, 'myorg', 'backend');
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ id: 10, login: 'alice' });
  });
});

// ── Helper: getRepo ───────────────────────────────────────────────────────────

describe('getRepo', () => {
  it('returns mapped RepoSummary', async () => {
    const fetch = makeFetch({
      default_branch: 'main',
      full_name: 'myorg/my-repo',
      html_url: 'https://github.com/myorg/my-repo',
      id: 99,
      name: 'my-repo',
      owner: { login: 'myorg' },
      private: true,
    });
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });

    const repo = await getRepo(client, 'myorg', 'my-repo');
    expect(repo).toEqual({
      default_branch: 'main',
      full_name: 'myorg/my-repo',
      id: 99,
      is_private: true,
      name: 'my-repo',
      owner: 'myorg',
      url: 'https://github.com/myorg/my-repo',
    });
  });
});
