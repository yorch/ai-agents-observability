import type { PrismaClient } from '@ai-agents-observability/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runSweepAbandoned } from '../src/jobs/sweep-abandoned.ts';

function asDb(mock: ReturnType<typeof makeMockDb>): PrismaClient {
  return mock as unknown as PrismaClient;
}

// ── Mock PrismaClient ────────────────────────────────────────────────────────

type SessionStatus = 'active' | 'abandoned' | 'completed' | 'crashed' | 'timed_out';

interface MockSession {
  lastEventAt: Date;
  sessionId: string;
  status: SessionStatus;
}

interface MockJobRun {
  errorText: string | null;
  finishedAt: Date | null;
  id: bigint;
  jobName: string;
  startedAt: Date;
  status: string;
}

function makeMockDb() {
  const sessions: MockSession[] = [];
  const jobRuns: MockJobRun[] = [];
  let jobRunIdCounter = 1n;
  let lockAcquired = false;

  return {
    _jobRuns: jobRuns,
    _sessions: sessions,
    $queryRaw: vi.fn(async (query: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = query.join('?');
      if (sql.includes('pg_try_advisory_lock')) {
        // First call acquires; subsequent ones fail (simulate single-process)
        if (!lockAcquired) {
          lockAcquired = true;
          return [{ pg_try_advisory_lock: true }];
        }
        return [{ pg_try_advisory_lock: false }];
      }
      if (sql.includes('pg_advisory_unlock')) {
        lockAcquired = false;
        return [{ pg_advisory_unlock: true }];
      }
      return [];
    }),
    jobRun: {
      create: vi.fn(async (args: { data: Omit<MockJobRun, 'id'> }) => {
        const id = jobRunIdCounter++;
        const run: MockJobRun = { id, ...args.data };
        jobRuns.push(run);
        return run;
      }),
      update: vi.fn(async (args: { data: Partial<MockJobRun>; where: { id: bigint } }) => {
        const run = jobRuns.find((r) => r.id === args.where.id);
        if (run) {
          Object.assign(run, args.data);
        }
        return run;
      }),
    },
    session: {
      updateMany: vi.fn(
        async (args: {
          data: { status: SessionStatus };
          where: { status: string; lastEventAt: { lt: Date } };
        }) => {
          const cutoff = args.where.lastEventAt.lt;
          let count = 0;
          for (const s of sessions) {
            if (s.status === args.where.status && s.lastEventAt < cutoff) {
              s.status = args.data.status;
              count++;
            }
          }
          return { count };
        },
      ),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runSweepAbandoned', () => {
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
  });

  it('marks active sessions with lastEventAt > 24h ago as abandoned', async () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    db._sessions.push({
      lastEventAt: twentyFiveHoursAgo,
      sessionId: 'session-old',
      status: 'active',
    });

    await runSweepAbandoned(asDb(db));

    expect(db._sessions[0]?.status).toBe('abandoned');
  });

  it('does not mark sessions that are recent', async () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    db._sessions.push({
      lastEventAt: oneHourAgo,
      sessionId: 'session-recent',
      status: 'active',
    });

    await runSweepAbandoned(asDb(db));

    expect(db._sessions[0]?.status).toBe('active');
  });

  it('does not touch completed sessions even if old', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    db._sessions.push({
      lastEventAt: old,
      sessionId: 'session-done',
      status: 'completed',
    });

    await runSweepAbandoned(asDb(db));

    expect(db._sessions[0]?.status).toBe('completed');
  });

  it('writes a JobRun row with status=success', async () => {
    await runSweepAbandoned(asDb(db));

    expect(db._jobRuns).toHaveLength(1);
    expect(db._jobRuns[0]?.jobName).toBe('sweep-abandoned');
    expect(db._jobRuns[0]?.status).toBe('success');
    expect(db._jobRuns[0]?.finishedAt).toBeInstanceOf(Date);
  });

  it('skips run if advisory lock is not available', async () => {
    // Pre-consume the lock by calling once
    await runSweepAbandoned(asDb(db));
    // Reset the lock state manually by clearing the counter
    // Second run: lock was released, so re-acquire
    // Simulate a concurrent lock holder by setting lockAcquired manually
    // We test this by patching $queryRaw to always return false
    db.$queryRaw = vi.fn(async () => [{ pg_try_advisory_lock: false }]);
    const runsBefore = db._jobRuns.length;

    await runSweepAbandoned(asDb(db));

    // No new job run should have been created
    expect(db._jobRuns.length).toBe(runsBefore);
  });
});
