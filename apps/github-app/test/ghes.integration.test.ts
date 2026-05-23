import { describe, expect, it, vi } from 'vitest';
import type { PrUpsertDb } from '../src/lib/pr-upsert';
import { upsertPullRequest } from '../src/lib/pr-upsert';
import closedMergedFixture from './fixtures/ghes/pull_request.closed.merged.json';
import openedFixture from './fixtures/ghes/pull_request.opened.json';
import synchronizeFixture from './fixtures/ghes/pull_request.synchronize.json';

const stubDb: PrUpsertDb = {
  pullRequest: {
    upsert: vi.fn().mockResolvedValue({}),
  },
  repo: {
    upsert: vi.fn().mockResolvedValue({ id: 'test-repo-id' }),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
};

describe('GHES payload compatibility', () => {
  it('pull_request.opened: upserts PR with correct fields', async () => {
    const pr = openedFixture.pull_request;
    const repo = openedFixture.repository;
    const result = await upsertPullRequest(stubDb, repo, pr, 'open');
    expect(result.repoId).toBe('test-repo-id');
    expect(result.prNumber).toBe(42);
    // html_url domain does not affect the result
    expect(stubDb.repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ githubName: 'backend', githubOwner: 'acme-corp' }),
      }),
    );
  });

  it('pull_request.synchronize: upserts without error', async () => {
    const pr = synchronizeFixture.pull_request;
    const repo = synchronizeFixture.repository;
    const result = await upsertPullRequest(stubDb, repo, pr, 'open');
    expect(result.prNumber).toBe(42);
  });

  it('pull_request.closed (merged): sets merged state and timestamps', async () => {
    const pr = closedMergedFixture.pull_request;
    const repo = closedMergedFixture.repository;
    const result = await upsertPullRequest(stubDb, repo, pr, 'merged');
    expect(result.prNumber).toBe(42);
    // Verify merged fields were passed
    const upsertMock = stubDb.pullRequest.upsert as ReturnType<typeof vi.fn>;
    const call = upsertMock.mock.calls.at(-1)?.[0] as {
      create: { mergedAt: unknown; linesAdded: unknown; linesRemoved: unknown; labels: unknown[] };
    };
    expect(call.create.mergedAt).toBeInstanceOf(Date);
    expect(call.create.linesAdded).toBe(120);
    expect(call.create.linesRemoved).toBe(30);
    expect(call.create.labels).toEqual(['enhancement']);
  });

  it('GHES installation=null does not break upsert', async () => {
    const pr = closedMergedFixture.pull_request;
    const repo = closedMergedFixture.repository;
    // installation is null in GHES fixtures — ensure no crash
    await expect(upsertPullRequest(stubDb, repo, pr, 'merged')).resolves.toBeDefined();
  });
});
