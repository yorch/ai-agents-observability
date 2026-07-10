import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { handlePush, type PushPayload } from './push';

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

function makeDb(sessionIds: string[] = ['s1']) {
  return {
    repo: {
      findFirst: vi.fn().mockResolvedValue({ defaultBranch: 'main', id: 'repo-id' }),
      update: vi.fn().mockResolvedValue({}),
    },
    session: {
      findMany: vi.fn().mockResolvedValue(sessionIds.map((sessionId) => ({ sessionId }))),
    },
    sessionCommitLink: {
      createMany: vi.fn().mockResolvedValue({ count: sessionIds.length }),
    },
  };
}

function payload(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    commits: [
      {
        author: { username: 'jorge' },
        id: 'sha-1',
        timestamp: '2026-01-02T12:00:00Z',
      },
    ],
    ref: 'refs/heads/main',
    repository: { default_branch: 'main', full_name: 'acme/widget' },
    ...overrides,
  };
}

describe('handlePush', () => {
  it('links default-branch commits to sessions by author + time window', async () => {
    const db = makeDb(['s1', 's2']);

    await handlePush(payload(), db as never, logger);

    expect(db.session.findMany).toHaveBeenCalledWith({
      select: { sessionId: true },
      where: {
        githubLogin: 'jorge',
        lastEventAt: { gte: new Date('2026-01-01T12:00:00Z') },
        repoId: 'repo-id',
        startedAt: { lte: new Date('2026-01-02T12:00:00Z') },
      },
    });
    expect(db.sessionCommitLink.createMany).toHaveBeenCalledWith({
      data: [
        {
          authorLogin: 'jorge',
          commitSha: 'sha-1',
          committedAt: new Date('2026-01-02T12:00:00Z'),
          repoId: 'repo-id',
          sessionId: 's1',
        },
        {
          authorLogin: 'jorge',
          commitSha: 'sha-1',
          committedAt: new Date('2026-01-02T12:00:00Z'),
          repoId: 'repo-id',
          sessionId: 's2',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('ignores pushes to non-default branches', async () => {
    const db = makeDb();

    await handlePush(payload({ ref: 'refs/heads/feature/x' }), db as never, logger);

    expect(db.session.findMany).not.toHaveBeenCalled();
    expect(db.sessionCommitLink.createMany).not.toHaveBeenCalled();
  });

  it('skips commits without an author username', async () => {
    const db = makeDb();

    await handlePush(
      payload({ commits: [{ author: {}, id: 'sha-2', timestamp: '2026-01-02T12:00:00Z' }] }),
      db as never,
      logger,
    );

    expect(db.sessionCommitLink.createMany).not.toHaveBeenCalled();
  });

  it('updates the stored default branch when it changed', async () => {
    const db = makeDb([]);

    await handlePush(
      payload({
        ref: 'refs/heads/trunk',
        repository: { default_branch: 'trunk', full_name: 'acme/widget' },
      }),
      db as never,
      logger,
    );

    expect(db.repo.update).toHaveBeenCalledWith({
      data: { defaultBranch: 'trunk' },
      where: { id: 'repo-id' },
    });
  });
});
