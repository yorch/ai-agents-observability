import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { type CheckRunPayload, handleCheckRun } from './check-run';

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

function makeDb({ repoFound = true, prFound = true } = {}) {
  return {
    pRCheckRun: { upsert: vi.fn().mockResolvedValue({}) },
    pRRollup: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    pullRequest: {
      findUnique: vi.fn().mockResolvedValue(prFound ? { prNumber: 7 } : null),
    },
    repo: { findFirst: vi.fn().mockResolvedValue(repoFound ? { id: 'repo-id' } : null) },
  };
}

function payload(overrides: Partial<NonNullable<CheckRunPayload['check_run']>> = {}) {
  return {
    action: 'completed',
    check_run: {
      completed_at: '2026-01-02T00:10:00Z',
      conclusion: 'failure',
      head_sha: 'abc123',
      id: 991,
      name: 'ci/test',
      pull_requests: [{ number: 7 }],
      started_at: '2026-01-02T00:00:00Z',
      status: 'completed',
      ...overrides,
    },
    repository: { full_name: 'acme/widget' },
  } as CheckRunPayload;
}

describe('handleCheckRun', () => {
  it('stores a per-run outcome row and increments the failure counter', async () => {
    const db = makeDb();

    await handleCheckRun(payload(), db as never, logger);

    expect(db.pRCheckRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          conclusion: 'failure',
          githubId: 991n,
          headSha: 'abc123',
          name: 'ci/test',
          prNumber: 7,
          repoId: 'repo-id',
          status: 'completed',
        }),
      }),
    );
    expect(db.pRRollup.updateMany).toHaveBeenCalledWith({
      data: { checkFailuresCount: { increment: 1 } },
      where: { prNumber: 7, repoId: 'repo-id' },
    });
  });

  it('stores successful runs without touching the failure counter', async () => {
    const db = makeDb();

    await handleCheckRun(payload({ conclusion: 'success' }), db as never, logger);

    expect(db.pRCheckRun.upsert).toHaveBeenCalled();
    expect(db.pRRollup.updateMany).not.toHaveBeenCalled();
  });

  it('skips PRs that are not tracked yet', async () => {
    const db = makeDb({ prFound: false });

    await handleCheckRun(payload(), db as never, logger);

    expect(db.pRCheckRun.upsert).not.toHaveBeenCalled();
    expect(db.pRRollup.updateMany).not.toHaveBeenCalled();
  });

  it('no-ops for unknown repos', async () => {
    const db = makeDb({ repoFound: false });

    await handleCheckRun(payload(), db as never, logger);

    expect(db.pRCheckRun.upsert).not.toHaveBeenCalled();
  });
});
