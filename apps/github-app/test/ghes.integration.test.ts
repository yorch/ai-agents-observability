import { describe, expect, it, vi } from 'vitest';
import openedFixture from './fixtures/ghes/pull_request.opened.json';
import synchronizeFixture from './fixtures/ghes/pull_request.synchronize.json';
import closedMergedFixture from './fixtures/ghes/pull_request.closed.merged.json';
import { upsertPullRequest } from '../src/lib/pr-upsert';

// Capture the most recent upsert call for assertion
let lastUpsertArgs: unknown = null;

const stubDb = {
  repo: {
    upsert: vi.fn().mockResolvedValue({ id: 'test-repo-id' }),
  },
  pullRequest: {
    upsert: vi.fn().mockImplementation((args: unknown) => {
      lastUpsertArgs = args;
      return Promise.resolve({});
    }),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
} as any;

describe('GHES payload compatibility', () => {
  it('pull_request.opened: upserts PR with correct fields', async () => {
    const pr = openedFixture.pull_request as any;
    const repo = openedFixture.repository as any;
    const result = await upsertPullRequest(stubDb, repo, pr, 'open');
    expect(result.repoId).toBe('test-repo-id');
    expect(result.prNumber).toBe(42);
    // html_url domain does not affect the result
    expect(stubDb.repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ githubOwner: 'acme-corp', githubName: 'backend' }),
      })
    );
  });

  it('pull_request.synchronize: upserts without error', async () => {
    const pr = synchronizeFixture.pull_request as any;
    const repo = synchronizeFixture.repository as any;
    const result = await upsertPullRequest(stubDb, repo, pr, 'open');
    expect(result.prNumber).toBe(42);
  });

  it('pull_request.closed (merged): sets merged state and timestamps', async () => {
    const pr = closedMergedFixture.pull_request as any;
    const repo = closedMergedFixture.repository as any;
    const result = await upsertPullRequest(stubDb, repo, pr, 'merged');
    expect(result.prNumber).toBe(42);
    // Verify merged fields were passed
    const call = stubDb.pullRequest.upsert.mock.calls.at(-1)[0] as any;
    expect(call.create.mergedAt).toBeInstanceOf(Date);
    expect(call.create.linesAdded).toBe(120);
    expect(call.create.linesRemoved).toBe(30);
    expect(call.create.labels).toEqual(['enhancement']);
  });

  it('GHES installation=null does not break upsert', async () => {
    const pr = closedMergedFixture.pull_request as any;
    const repo = closedMergedFixture.repository as any;
    // installation is null in GHES fixtures — ensure no crash
    await expect(upsertPullRequest(stubDb, repo, pr, 'merged')).resolves.toBeDefined();
  });
});
