import { describe, expect, it, vi } from 'vitest';

import { backfillPRLinks } from './backfill-pr-links';

type BackfillDb = Parameters<typeof backfillPRLinks>[0];

function makeDb(sessionIds: string[]) {
  return {
    pullRequest: {},
    session: {
      findMany: vi.fn().mockResolvedValue(sessionIds.map((sessionId) => ({ sessionId }))),
    },
    sessionPRLink: {
      createMany: vi.fn().mockResolvedValue({ count: sessionIds.length }),
    },
  } as unknown as BackfillDb;
}

describe('backfillPRLinks', () => {
  it('links matching branch sessions found in the PR lookback window', async () => {
    const db = makeDb(['s1', 's2']);
    const openedAt = new Date('2026-01-08T00:00:00Z');

    const count = await backfillPRLinks(db, 'repo-id', 42, 'feature/widget', openedAt);

    expect(count).toBe(2);
    expect(db.session.findMany).toHaveBeenCalledWith({
      select: { sessionId: true },
      where: {
        gitBranch: 'feature/widget',
        prLinks: { none: { prNumber: 42, repoId: 'repo-id' } },
        repoId: 'repo-id',
        startedAt: { gte: new Date('2026-01-01T00:00:00Z') },
      },
    });
    expect(db.sessionPRLink.createMany).toHaveBeenCalledWith({
      data: [
        {
          linkSource: 'WEBHOOK_RECONCILE',
          prNumber: 42,
          repoId: 'repo-id',
          sessionId: 's1',
        },
        {
          linkSource: 'WEBHOOK_RECONCILE',
          prNumber: 42,
          repoId: 'repo-id',
          sessionId: 's2',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('does not write links when no sessions match', async () => {
    const db = makeDb([]);

    const count = await backfillPRLinks(db, 'repo-id', 42, 'feature/widget', null);

    expect(count).toBe(0);
    expect(db.sessionPRLink.createMany).not.toHaveBeenCalled();
  });

  it('uses the epoch as the lower bound when PR opened_at is missing', async () => {
    const db = makeDb([]);

    await backfillPRLinks(db, 'repo-id', 42, 'feature/widget', null);

    expect(db.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startedAt: { gte: new Date(0) },
        }),
      }),
    );
  });
});
