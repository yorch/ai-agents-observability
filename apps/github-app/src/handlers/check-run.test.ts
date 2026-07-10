import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { type CheckRunPayload, handleCheckRun } from './check-run';

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

function makeDb({ repoFound = true, trackedPrs = [7], failureCount = 1 } = {}) {
  return {
    pRCheckRun: {
      count: vi.fn().mockResolvedValue(failureCount),
      upsert: vi.fn().mockResolvedValue({}),
    },
    pRRollup: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    pullRequest: {
      findMany: vi.fn().mockResolvedValue(trackedPrs.map((prNumber) => ({ prNumber }))),
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
  it('stores a per-run outcome row and recomputes the failure counter from rows', async () => {
    const db = makeDb({ failureCount: 2 });

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
    // Counter is derived (set), not incremented — redeliveries can't drift it.
    expect(db.pRRollup.updateMany).toHaveBeenCalledWith({
      data: { checkFailuresCount: 2 },
      where: { prNumber: 7, repoId: 'repo-id' },
    });
  });

  it('stores in-progress runs without touching the failure counter', async () => {
    const db = makeDb();

    await handleCheckRun(payload({ conclusion: null, status: 'in_progress' }), db as never, logger);

    expect(db.pRCheckRun.upsert).toHaveBeenCalled();
    expect(db.pRRollup.updateMany).not.toHaveBeenCalled();
  });

  it('recomputes the counter on success too (a re-run may have cleared failures)', async () => {
    const db = makeDb({ failureCount: 0 });

    await handleCheckRun(payload({ conclusion: 'success' }), db as never, logger);

    expect(db.pRRollup.updateMany).toHaveBeenCalledWith({
      data: { checkFailuresCount: 0 },
      where: { prNumber: 7, repoId: 'repo-id' },
    });
  });

  it('skips PRs that are not tracked yet', async () => {
    const db = makeDb({ trackedPrs: [] });

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
