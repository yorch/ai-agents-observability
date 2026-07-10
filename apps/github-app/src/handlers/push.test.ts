import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../config';
import { handlePush, type PushPayload } from './push';

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
const config = { commit_link_grace_hours: 24 } as Config;

type SessionFixture = { lastEventAt: Date; sessionId: string; startedAt: Date };

function makeDb(sessions: SessionFixture[] = []) {
  return {
    repo: {
      findFirst: vi.fn().mockResolvedValue({ defaultBranch: 'main', id: 'repo-id' }),
      update: vi.fn().mockResolvedValue({}),
    },
    session: {
      findMany: vi.fn().mockResolvedValue(sessions),
    },
    sessionCommitLink: {
      createMany: vi.fn().mockResolvedValue({ count: sessions.length }),
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
    // s1/s2 overlap the commit; s3 ended more than the grace period before it.
    const db = makeDb([
      {
        lastEventAt: new Date('2026-01-02T11:00:00Z'),
        sessionId: 's1',
        startedAt: new Date('2026-01-02T09:00:00Z'),
      },
      {
        lastEventAt: new Date('2026-01-02T13:00:00Z'),
        sessionId: 's2',
        startedAt: new Date('2026-01-02T10:00:00Z'),
      },
      {
        lastEventAt: new Date('2026-01-01T10:00:00Z'),
        sessionId: 's3',
        startedAt: new Date('2026-01-01T09:00:00Z'),
      },
    ]);

    await handlePush(payload(), db as never, config, logger);

    // One superset query for the author covering all of the push's commits.
    expect(db.session.findMany).toHaveBeenCalledTimes(1);
    expect(db.session.findMany).toHaveBeenCalledWith({
      select: { lastEventAt: true, sessionId: true, startedAt: true },
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

  it('queries once per author even for multi-commit pushes', async () => {
    const db = makeDb([
      {
        lastEventAt: new Date('2026-01-02T13:00:00Z'),
        sessionId: 's1',
        startedAt: new Date('2026-01-02T09:00:00Z'),
      },
    ]);

    await handlePush(
      payload({
        commits: [
          { author: { username: 'jorge' }, id: 'sha-1', timestamp: '2026-01-02T12:00:00Z' },
          { author: { username: 'jorge' }, id: 'sha-2', timestamp: '2026-01-02T12:05:00Z' },
          { author: { username: 'jorge' }, id: 'sha-3', timestamp: '2026-01-02T12:10:00Z' },
        ],
      }),
      db as never,
      config,
      logger,
    );

    expect(db.session.findMany).toHaveBeenCalledTimes(1);
    expect(db.sessionCommitLink.createMany).toHaveBeenCalledTimes(1);
    const { data } = (db.sessionCommitLink.createMany.mock.calls[0] as [{ data: unknown[] }])[0];
    expect(data).toHaveLength(3);
  });

  it('ignores pushes to non-default branches', async () => {
    const db = makeDb();

    await handlePush(payload({ ref: 'refs/heads/feature/x' }), db as never, config, logger);

    expect(db.session.findMany).not.toHaveBeenCalled();
    expect(db.sessionCommitLink.createMany).not.toHaveBeenCalled();
  });

  it('skips commits without an author username', async () => {
    const db = makeDb();

    await handlePush(
      payload({ commits: [{ author: {}, id: 'sha-2', timestamp: '2026-01-02T12:00:00Z' }] }),
      db as never,
      config,
      logger,
    );

    expect(db.sessionCommitLink.createMany).not.toHaveBeenCalled();
  });

  it('updates the stored default branch when it changed', async () => {
    const db = makeDb();

    await handlePush(
      payload({
        ref: 'refs/heads/trunk',
        repository: { default_branch: 'trunk', full_name: 'acme/widget' },
      }),
      db as never,
      config,
      logger,
    );

    expect(db.repo.update).toHaveBeenCalledWith({
      data: { defaultBranch: 'trunk' },
      where: { id: 'repo-id' },
    });
  });
});
