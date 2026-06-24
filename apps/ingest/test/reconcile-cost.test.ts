import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the db package so the module imports without the generated Prisma client.
// reconcile-cost.ts only uses Prisma.sql (tagged template → { strings, values }).
vi.mock('@ai-agents-observability/db', () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

import {
  type BillingSource,
  NullBillingSource,
  runReconcileCost,
} from '../src/jobs/reconcile-cost.ts';

// biome-ignore lint/suspicious/noExplicitAny: test double for PrismaClient
function asDb(mock: ReturnType<typeof makeMockDb>): any {
  return mock;
}

function introspect(arg0: unknown): string {
  if (Array.isArray(arg0)) {
    return (arg0 as string[]).join(' ');
  }
  const sql = arg0 as { sql?: string; strings?: string[] };
  return sql.strings ? sql.strings.join(' ') : (sql.sql ?? String(arg0));
}

function makeMockDb(opts?: {
  lockAlwaysFails?: boolean;
  rows?: { agent_type: string; client_cost: number }[];
}) {
  const jobRuns: { id: bigint; jobName: string; status: string }[] = [];
  let idCounter = 1n;
  let lockHeld = false;

  return {
    _jobRuns: jobRuns,
    $queryRaw: vi.fn(async (arg0: unknown) => {
      const text = introspect(arg0);
      if (text.includes('pg_try_advisory_lock')) {
        if (opts?.lockAlwaysFails) {
          return [{ pg_try_advisory_lock: false }];
        }
        if (!lockHeld) {
          lockHeld = true;
          return [{ pg_try_advisory_lock: true }];
        }
        return [{ pg_try_advisory_lock: false }];
      }
      if (text.includes('pg_advisory_unlock')) {
        lockHeld = false;
        return [{ pg_advisory_unlock: true }];
      }
      if (text.includes('SUM(cost_usd)')) {
        return opts?.rows ?? [];
      }
      return [];
    }),
    jobRun: {
      create: vi.fn(async (args: { data: { jobName: string; status: string } }) => {
        const run = { id: idCounter++, ...args.data };
        jobRuns.push(run);
        return run;
      }),
      update: vi.fn(async (args: { data: { status?: string }; where: { id: bigint } }) => {
        const run = jobRuns.find((r) => r.id === args.where.id);
        if (run && args.data.status) {
          run.status = args.data.status;
        }
        return run;
      }),
    },
  };
}

describe('runReconcileCost', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reconciles the previous calendar month and queries the billing source per agent', async () => {
    const db = makeMockDb({
      rows: [
        { agent_type: 'CLAUDE_CODE', client_cost: 100 },
        { agent_type: 'OPENCODE', client_cost: 20 },
      ],
    });
    const fetchBilledCost = vi.fn(async () => 100);
    const source: BillingSource = { fetchBilledCost };

    await runReconcileCost(asDb(db), source, { now: new Date('2026-06-15T00:00:00Z') });

    // Previous month = May 2026 → year 2026, month 5 (1-based).
    expect(fetchBilledCost).toHaveBeenCalledWith('CLAUDE_CODE', 2026, 5);
    expect(fetchBilledCost).toHaveBeenCalledWith('OPENCODE', 2026, 5);
    expect(db._jobRuns[0]?.jobName).toBe('reconcile-cost');
    expect(db._jobRuns[0]?.status).toBe('success');
  });

  it('runs with NullBillingSource without crashing (no comparison)', async () => {
    const db = makeMockDb({ rows: [{ agent_type: 'CLAUDE_CODE', client_cost: 42 }] });

    await runReconcileCost(asDb(db), new NullBillingSource(), {
      now: new Date('2026-03-10T00:00:00Z'),
    });

    expect(db._jobRuns[0]?.status).toBe('success');
  });

  it('skips when the advisory lock is unavailable', async () => {
    const db = makeMockDb({ lockAlwaysFails: true, rows: [] });
    const fetchBilledCost = vi.fn(async () => 1);

    await runReconcileCost(
      asDb(db),
      { fetchBilledCost },
      { now: new Date('2026-06-15T00:00:00Z') },
    );

    expect(db._jobRuns).toHaveLength(0);
    expect(fetchBilledCost).not.toHaveBeenCalled();
  });
});
