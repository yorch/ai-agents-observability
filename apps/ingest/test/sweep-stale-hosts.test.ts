import type { PrismaClient } from '@ai-agents-observability/db';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runSweepStaleHosts } from '../src/jobs/sweep-stale-hosts';

function asDb(mock: ReturnType<typeof makeMockDb>): PrismaClient {
  return mock as unknown as PrismaClient;
}

// ── Mock PrismaClient ────────────────────────────────────────────────────────

interface MockJobRun {
  errorText: string | null;
  finishedAt: Date | null;
  id: bigint;
  jobName: string;
  startedAt: Date;
  status: string;
}

interface StaleHostRow {
  host_hash: string;
  latest_event: Date;
  session_count: bigint;
}

function makeMockDb(staleHosts: StaleHostRow[] = []) {
  const jobRuns: MockJobRun[] = [];
  let jobRunIdCounter = 1n;
  let lockAcquired = false;
  const warnCalls: Array<{ msg: string; data: Record<string, unknown> }> = [];
  const infoCalls: Array<{ msg: string; data: Record<string, unknown> }> = [];

  const logger = {
    error: vi.fn(),
    info: vi.fn((data: Record<string, unknown>, msg: string) => infoCalls.push({ data, msg })),
    warn: vi.fn((data: Record<string, unknown>, msg: string) => warnCalls.push({ data, msg })),
  };

  return {
    _infoCalls: infoCalls,
    _jobRuns: jobRuns,
    _logger: logger,
    _staleHosts: staleHosts,
    _warnCalls: warnCalls,
    $queryRaw: vi.fn(async (query: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = query.join('?');
      if (sql.includes('pg_try_advisory_lock')) {
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
      // The stale-hosts query — return the mock rows.
      if (sql.includes('host_hash')) {
        return staleHosts;
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
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runSweepStaleHosts', () => {
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
  });

  it('writes a JobRun row with status=success', async () => {
    await runSweepStaleHosts(asDb(db), db._logger as unknown as Logger);

    expect(db._jobRuns).toHaveLength(1);
    expect(db._jobRuns[0]?.jobName).toBe('sweep-stale-hosts');
    expect(db._jobRuns[0]?.status).toBe('success');
    expect(db._jobRuns[0]?.finishedAt).toBeInstanceOf(Date);
  });

  it('logs a warning for each stale host', async () => {
    const staleHosts: StaleHostRow[] = [
      {
        host_hash: 'hash-aaa',
        latest_event: new Date(Date.now() - 30 * 3_600_000), // 30h ago
        session_count: 5n,
      },
      {
        host_hash: 'hash-bbb',
        latest_event: new Date(Date.now() - 48 * 3_600_000), // 48h ago
        session_count: 12n,
      },
    ];
    db = makeMockDb(staleHosts);

    await runSweepStaleHosts(asDb(db), db._logger as unknown as Logger);

    // One warn per stale host + one info summary
    expect(db._warnCalls).toHaveLength(2);
    expect(db._warnCalls[0]?.data.host_hash).toBe('hash-aaa');
    expect(db._warnCalls[1]?.data.host_hash).toBe('hash-bbb');
    expect(db._infoCalls).toHaveLength(1);
    expect(db._infoCalls[0]?.data.count).toBe(2);
  });

  it('does not log warnings when there are no stale hosts', async () => {
    await runSweepStaleHosts(asDb(db), db._logger as unknown as Logger);

    expect(db._warnCalls).toHaveLength(0);
    expect(db._infoCalls).toHaveLength(0);
  });

  it('skips run if advisory lock is not available', async () => {
    // First call acquires the lock
    await runSweepStaleHosts(asDb(db), db._logger as unknown as Logger);
    // Patch to always refuse
    db.$queryRaw = vi.fn(async () => [{ pg_try_advisory_lock: false }]);
    const runsBefore = db._jobRuns.length;

    await runSweepStaleHosts(asDb(db), db._logger as unknown as Logger);

    expect(db._jobRuns.length).toBe(runsBefore);
  });
});
