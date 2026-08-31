import { describe, expect, it, vi } from 'vitest';

// Mock the db package so this file imports without the generated Prisma client.
// refresh-caggs only uses the raw query paths and the withJobRun scaffold.
vi.mock('@ai-agents-observability/db', () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

import { REFRESHED_CAGGS, runRefreshCaggs } from '../src/jobs/refresh-caggs';

function sqlText(arg: unknown): string {
  const s = arg as { strings?: string[] | TemplateStringsArray };
  return s?.strings ? Array.from(s.strings).join(' ') : String(arg);
}

function makeDb(lockAcquired = true) {
  const executed: string[] = [];
  return {
    _executed: executed,
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
    $queryRaw: vi.fn(async (arg: unknown) => {
      const text = sqlText(arg);
      if (text.includes('pg_try_advisory_lock')) {
        return [{ pg_try_advisory_lock: lockAcquired }];
      }
      return [{ pg_advisory_unlock: true }];
    }),
    jobRun: {
      create: vi.fn(async () => ({ id: 1n })),
      update: vi.fn(async () => ({})),
    },
  };
}

type Db = Parameters<typeof runRefreshCaggs>[0];

const NOW = new Date('2026-08-31T13:45:00.000Z');

describe('runRefreshCaggs', () => {
  it('refreshes every aggregate from the beginning of time', async () => {
    const db = makeDb();

    await runRefreshCaggs(db as unknown as Db, undefined, NOW);

    expect(db._executed).toHaveLength(REFRESHED_CAGGS.length);
    for (const cagg of REFRESHED_CAGGS) {
      expect(db._executed).toContain(
        `CALL refresh_continuous_aggregate('${cagg}', NULL, '2026-08-31T00:00:00.000Z')`,
      );
    }
  });

  // An unbounded lower bound is the whole point: a gap check anchored on the
  // aggregate's current min(day) would miss a re-import that dirties buckets
  // already inside the materialized range.
  it('uses an unbounded lower bound rather than a computed start', async () => {
    const db = makeDb();

    await runRefreshCaggs(db as unknown as Db, undefined, NOW);

    for (const sql of db._executed) {
      expect(sql).toContain(', NULL, ');
    }
  });

  // Materializing today's partial bucket would freeze it until the next run,
  // where real-time aggregation currently serves it live and correct.
  it('never refreshes past midnight UTC of the current day', async () => {
    const db = makeDb();

    await runRefreshCaggs(db as unknown as Db, undefined, NOW);

    for (const sql of db._executed) {
      expect(sql).toContain("'2026-08-31T00:00:00.000Z'");
      expect(sql).not.toContain('T13:45');
    }
  });

  it('records a JobRun and marks it successful', async () => {
    const db = makeDb();

    await runRefreshCaggs(db as unknown as Db, undefined, NOW);

    expect(db.jobRun.create).toHaveBeenCalledTimes(1);
    expect(db.jobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'success' }) }),
    );
  });

  it('skips the run when another instance holds the advisory lock', async () => {
    const db = makeDb(false);

    await runRefreshCaggs(db as unknown as Db, undefined, NOW);

    expect(db._executed).toHaveLength(0);
    expect(db.jobRun.create).not.toHaveBeenCalled();
  });
});
