import { describe, expect, it, vi } from 'vitest';

// Mock the db package so this file imports without the generated Prisma client.
// reprice-events only uses Prisma.sql / Prisma.join (tagged templates) and
// computePRRollup.
vi.mock('@ai-agents-observability/db', () => ({
  computePRRollup: vi.fn(async () => ({ contributorCount: 0, sessionCount: 0, totalCostUsd: 0 })),
  Prisma: {
    join: (parts: unknown[], sep: string) => ({ sep, strings: [], values: parts }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

import type { PriceTable } from '@ai-agents-observability/schemas';

import { planReprice, runRepriceEvents } from '../src/jobs/reprice-events';
import type { PriceTableRegistry } from '../src/lib/price-tables';

const TABLE: PriceTable = {
  generated_at: '2026-08-18T00:00:00Z',
  prices: {
    'gpt-5.4': {
      cache_read_per_mtok: 0.25,
      cache_write_per_mtok: 2.5,
      input_per_mtok: 2.5,
      output_per_mtok: 15,
    },
  },
  version: 'test',
};

const registry: PriceTableRegistry = { forAgentParam: () => TABLE, resolve: () => TABLE };

function sqlText(arg: unknown): string {
  const s = arg as { strings?: string[] };
  return Array.isArray(s.strings) ? s.strings.join(' ') : String(arg);
}

type Pair = { agent_type: string; events: number; model: string };

function makeDb(pairs: Pair[], planRows: unknown[] = []) {
  const executed: string[] = [];
  const db = {
    _executed: executed,
    $executeRaw: vi.fn(async (arg: unknown) => {
      executed.push(sqlText(arg));
      return 0;
    }),
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
    $queryRaw: vi.fn(async (arg: unknown) => {
      const text = sqlText(arg);
      if (text.includes('pg_try_advisory_lock')) {
        return [{ pg_try_advisory_lock: true }];
      }
      if (text.includes('pg_advisory_unlock')) {
        return [{ pg_advisory_unlock: true }];
      }
      if (text.includes('GROUP BY agent_type, model')) {
        return pairs;
      }
      if (text.includes('HAVING')) {
        return planRows;
      }
      if (text.includes('timescaledb_information.chunks')) {
        return [];
      }
      if (text.includes('session_pr_links')) {
        return [];
      }
      executed.push(text);
      return [];
    }),
    jobRun: {
      create: vi.fn(async (args: { data: { jobName: string } }) => ({
        id: 1n,
        jobName: args.data.jobName,
      })),
      update: vi.fn(async () => ({})),
    },
  };
  return db;
}

// biome-ignore lint/suspicious/noExplicitAny: test double for PrismaClient
const asDb = (db: ReturnType<typeof makeDb>): any => db;

describe('reprice-events', () => {
  it('separates priced models from unpriced ones', async () => {
    const db = makeDb([
      { agent_type: 'CODEX', events: 10, model: 'gpt-5.4' },
      { agent_type: 'CODEX', events: 3, model: 'gpt-9-imaginary' },
    ]);

    const plan = await planReprice(asDb(db), registry);

    expect(plan.unpriced).toEqual([{ agentType: 'CODEX', events: 3, model: 'gpt-9-imaginary' }]);
  });

  it('resolves a <provider>/ prefixed model against the bare price row', async () => {
    // Same fallback ingest uses, so the job cannot price a session the live
    // path would have priced differently.
    const db = makeDb([{ agent_type: 'PI', events: 4, model: 'openrouter/gpt-5.4' }]);

    const plan = await planReprice(asDb(db), registry);

    expect(plan.unpriced).toEqual([]);
  });

  it('never writes on a dry run, however much would change', async () => {
    const db = makeDb(
      [{ agent_type: 'CODEX', events: 10, model: 'gpt-5.4' }],
      [{ agent_type: 'CODEX', events: 10, model: 'gpt-5.4', new_cost: 20, old_cost: 9990 }],
    );

    await runRepriceEvents(asDb(db), registry);

    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.jobRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jobName: 'reprice-events' }) }),
    );
  });

  it('stops before touching sessions or aggregates when nothing would change', async () => {
    // An apply with an empty plan must not spend a full-table session recompute
    // and two whole-range aggregate refreshes to write nothing.
    const db = makeDb([{ agent_type: 'CODEX', events: 10, model: 'gpt-5.4' }], []);

    await runRepriceEvents(asDb(db), registry, { apply: true });

    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('refreshes both cost aggregates on apply, and only those', async () => {
    const db = makeDb(
      [{ agent_type: 'CODEX', events: 10, model: 'gpt-5.4' }],
      [{ agent_type: 'CODEX', events: 10, model: 'gpt-5.4', new_cost: 20, old_cost: 9990 }],
    );

    await runRepriceEvents(asDb(db), registry, { apply: true });

    const refreshes = db._executed.filter((s) => s.includes('refresh_continuous_aggregate'));
    expect(refreshes).toHaveLength(2);
    expect(refreshes.join(' ')).toContain('daily_cost_by_user');
    expect(refreshes.join(' ')).toContain('daily_cost_by_model');
    // daily_tool_usage carries no cost column — refreshing it would be wasted work.
    expect(refreshes.join(' ')).not.toContain('daily_tool_usage');
  });

  it('records the run under the -apply name so the two are distinguishable', async () => {
    const db = makeDb(
      [{ agent_type: 'CODEX', events: 1, model: 'gpt-5.4' }],
      [{ agent_type: 'CODEX', events: 1, model: 'gpt-5.4', new_cost: 2, old_cost: 1 }],
    );

    await runRepriceEvents(asDb(db), registry, { apply: true });

    expect(db.jobRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobName: 'reprice-events-apply' }),
      }),
    );
  });
});
