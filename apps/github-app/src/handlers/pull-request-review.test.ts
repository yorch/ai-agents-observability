import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { handlePullRequestReview } from './pull-request-review';

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

type ReviewPayload = EmitterWebhookEvent<'pull_request_review'>['payload'];

function makeDb() {
  return {
    pRReview: {
      count: vi.fn().mockResolvedValue(3),
      upsert: vi.fn().mockResolvedValue({}),
    },
    pullRequest: {
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    repo: { upsert: vi.fn().mockResolvedValue({ id: 'repo-id' }) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

function payload(action: string, reviewState = 'approved'): ReviewPayload {
  return {
    action,
    pull_request: {
      base: { ref: 'main' },
      closed_at: null,
      created_at: '2026-01-01T00:00:00Z',
      head: { ref: 'feature/OBS-1' },
      html_url: 'https://github.com/acme/widget/pull/7',
      id: 456,
      labels: [],
      merged_at: null,
      number: 7,
      requested_reviewers: [],
      state: 'open',
      title: 'Add widget',
      user: { login: 'author' },
    },
    repository: { default_branch: 'main', full_name: 'acme/widget', id: 123 },
    review: {
      id: 777,
      state: reviewState,
      submitted_at: '2026-01-03T10:00:00Z',
      user: { login: 'reviewer' },
    },
  } as unknown as ReviewPayload;
}

describe('handlePullRequestReview', () => {
  it('stores the submitted review and maintains review_count', async () => {
    const db = makeDb();

    await handlePullRequestReview(payload('submitted'), db as never, logger);

    expect(db.pRReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          githubId: 777n,
          prNumber: 7,
          repoId: 'repo-id',
          reviewerLogin: 'reviewer',
          state: 'APPROVED',
          submittedAt: new Date('2026-01-03T10:00:00Z'),
        }),
        where: { githubId: 777n },
      }),
    );
    expect(db.pullRequest.update).toHaveBeenCalledWith({
      data: { reviewCount: 3 },
      where: { repoId_prNumber: { prNumber: 7, repoId: 'repo-id' } },
    });
  });

  it('marks dismissed reviews as DISMISSED', async () => {
    const db = makeDb();

    await handlePullRequestReview(payload('dismissed'), db as never, logger);

    expect(db.pRReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { state: 'DISMISSED' },
      }),
    );
  });

  it('ignores unrelated actions', async () => {
    const db = makeDb();

    await handlePullRequestReview(payload('unlocked'), db as never, logger);

    expect(db.pRReview.upsert).not.toHaveBeenCalled();
  });
});
