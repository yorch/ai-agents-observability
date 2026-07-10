import { describe, expect, it, vi } from 'vitest';

import { extractJiraKey, type PrUpsertDb, upsertPullRequest } from './pr-upsert';

const repoPayload = {
  full_name: 'acme/widget',
  id: 123,
};

const prPayload = {
  additions: 10,
  base: { ref: 'main' },
  changed_files: 2,
  created_at: '2026-01-01T00:00:00Z',
  deletions: 3,
  draft: false,
  head: { ref: 'feature/OBS-42-add-widget' },
  html_url: 'https://github.com/acme/widget/pull/7',
  id: 456,
  labels: [{ name: 'enhancement' }],
  merged: false,
  number: 7,
  requested_reviewers: [{ login: 'reviewer' }],
  title: 'Add widget',
  user: { login: 'author' },
};

function makeDb(overrides = {}): PrUpsertDb {
  return {
    pullRequest: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    repo: {
      upsert: vi.fn().mockResolvedValue({ id: 'repo-id' }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-id' }),
    },
    ...overrides,
  } as unknown as PrUpsertDb;
}

describe('extractJiraKey', () => {
  it('extracts the first Jira key from a branch name', () => {
    expect(extractJiraKey('feature/OBS-42-add-widget')).toBe('OBS-42');
  });

  it('supports project keys with digits', () => {
    expect(extractJiraKey('ABC1-999/fix')).toBe('ABC1-999');
  });

  it('returns null when no Jira key is present', () => {
    expect(extractJiraKey('feature/no-ticket')).toBeNull();
  });
});

describe('upsertPullRequest', () => {
  it('upserts the repo and pull request with mapped webhook fields', async () => {
    const db = makeDb();

    await upsertPullRequest(db, repoPayload, prPayload, 'OPEN');

    expect(db.repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { defaultBranch: null, githubId: 123n, githubName: 'widget', githubOwner: 'acme' },
        where: { githubOwner_githubName: { githubName: 'widget', githubOwner: 'acme' } },
      }),
    );
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { githubLogin: 'author' } });
    expect(db.pullRequest.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          authorGithubLogin: 'author',
          authorUserId: 'user-id',
          jiraKey: 'OBS-42',
          labels: ['enhancement'],
          reviewerLogins: ['reviewer'],
          state: 'OPEN',
        }),
        where: { repoId_prNumber: { prNumber: 7, repoId: 'repo-id' } },
      }),
    );
  });

  it('handles deleted GitHub users as ghost authors', async () => {
    const db = makeDb();

    await upsertPullRequest(db, repoPayload, { ...prPayload, user: null }, 'CLOSED');

    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.pullRequest.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          authorGithubLogin: 'ghost',
          authorUserId: null,
          state: 'CLOSED',
        }),
      }),
    );
  });

  it('falls back to the PR title, then body, for the Jira key', async () => {
    const db = makeDb();

    await upsertPullRequest(
      db,
      repoPayload,
      { ...prPayload, head: { ref: 'feature/no-ticket' }, title: 'OBS-77: add widget' },
      'OPEN',
    );
    expect(db.pullRequest.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ jiraKey: 'OBS-77' }) }),
    );

    await upsertPullRequest(
      db,
      repoPayload,
      {
        ...prPayload,
        body: 'Implements OBS-88 as discussed',
        head: { ref: 'feature/no-ticket' },
        title: 'add widget',
      },
      'OPEN',
    );
    expect(db.pullRequest.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ jiraKey: 'OBS-88' }) }),
    );
  });

  it('records the repo default branch when the payload carries it', async () => {
    const db = makeDb();

    await upsertPullRequest(db, { ...repoPayload, default_branch: 'main' }, prPayload, 'OPEN');

    expect(db.repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ defaultBranch: 'main' }),
        update: expect.objectContaining({ defaultBranch: 'main' }),
      }),
    );
  });

  it('retries once on a unique-constraint race', async () => {
    const db = makeDb({
      repo: {
        upsert: vi
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('race'), { code: 'P2002' }))
          .mockResolvedValueOnce({ id: 'repo-id' }),
      },
    });

    const result = await upsertPullRequest(db, repoPayload, prPayload, 'OPEN');

    expect(result).toEqual({ prNumber: 7, repoId: 'repo-id' });
    expect(db.repo.upsert).toHaveBeenCalledTimes(2);
    expect(db.pullRequest.upsert).toHaveBeenCalledTimes(1);
  });
});
