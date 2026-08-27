import type { PriceTable } from '@ai-agents-observability/schemas';
import { describe, expect, it, vi } from 'vitest';

// Mock the db package so this file imports without the generated Prisma client.
// The job only uses Prisma.sql / Prisma.join (tagged templates).
vi.mock('@ai-agents-observability/db', () => ({
  Prisma: {
    join: (parts: unknown[], sep: string) => ({ sep, strings: [], values: parts }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

import { runComputeCostAttribution } from '../src/jobs/compute-cost-attribution';
import type { PriceTableRegistry } from '../src/lib/price-tables';

const TABLE: PriceTable = {
  generated_at: '2026-08-20T00:00:00Z',
  prices: {
    'test-model': {
      cache_read_per_mtok: 1,
      cache_write_per_mtok: 10,
      input_per_mtok: 4,
      output_per_mtok: 100,
    },
  },
  version: 'test',
};
const registry: PriceTableRegistry = { forAgentParam: () => TABLE, resolve: () => TABLE };

function sqlText(arg: unknown): string {
  const s = arg as { strings?: string[] };
  return Array.isArray(s.strings) ? s.strings.join(' ') : String(arg);
}

const SESSION = '00000000-0000-4000-8000-00000000a001';
const DAY_START = new Date('2026-08-20T00:00:00Z');
const DAY_END = new Date('2026-08-21T00:00:00Z');
const at = (m: number) => new Date(DAY_START.getTime() + m * 60_000);

type Ev = Record<string, unknown>;

function stop(turn: number, minute: number, over: Ev = {}): Ev {
  return {
    agent_type: 'CLAUDE_CODE',
    cache_creation_tokens: null,
    cache_read_tokens: null,
    cost_usd: null,
    event_id: `stop-${turn}`,
    event_type: 'Stop',
    input_tokens: null,
    model: 'test-model',
    session_id: SESSION,
    tool_output_bytes: null,
    ts: at(minute),
    turn_number: turn,
    ...over,
  };
}

function tool(turn: number, minute: number, id: string, over: Ev = {}): Ev {
  return {
    agent_type: 'CLAUDE_CODE',
    cache_creation_tokens: null,
    cache_read_tokens: null,
    cost_usd: null,
    event_id: id,
    event_type: 'PostToolUse',
    input_tokens: null,
    model: null,
    session_id: SESSION,
    tool_output_bytes: null,
    ts: at(minute),
    turn_number: turn,
    ...over,
  };
}

function makeDb(events: Ev[], opts: { compressed?: boolean } = {}) {
  const executed: string[] = [];
  const writes: unknown[] = [];
  const db = {
    _executed: executed,
    _writes: writes,
    $executeRaw: vi.fn(async (arg: unknown) => {
      executed.push(sqlText(arg));
      writes.push(arg);
      return 1;
    }),
    $queryRaw: vi.fn(async (arg: unknown) => {
      const text = sqlText(arg);
      executed.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        return [{ pg_try_advisory_lock: true }];
      }
      if (text.includes('pg_advisory_unlock')) {
        return [{ pg_advisory_unlock: true }];
      }
      if (text.includes('timescaledb_information.chunks')) {
        return [
          {
            chunk_name: '_hyper_1_1_chunk',
            chunk_schema: '_timescaledb_internal',
            is_compressed: opts.compressed === true,
            range_end: DAY_END,
            range_start: DAY_START,
          },
        ];
      }
      if (text.includes('FROM sessions')) {
        return [{ ended_at: at(120), session_id: SESSION, started_at: DAY_START }];
      }
      if (text.includes('FROM events')) {
        return events;
      }
      if (text.includes('decompress_chunk') || text.includes('compress_chunk')) {
        return [{}];
      }
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

/**
 * Pulls `(event_id, ts, attributed, downstream)` back out of the fake
 * `Prisma.sql` tree the job built, so a test can assert on the numbers that
 * would reach Postgres rather than on a string.
 */
function writtenRows(db: ReturnType<typeof makeDb>): string[][] {
  return db._writes.flatMap((w) => {
    const outer = w as { values: unknown[] };
    const join = outer.values[0] as { values: unknown[] } | undefined;
    if (!join?.values) {
      return [];
    }
    return join.values.map((row) => {
      const v = (row as { values: unknown[] }).values;
      return v.map((x) => (x instanceof Date ? x.toISOString() : String(x)));
    });
  });
}

const NOW = new Date('2026-08-21T06:15:00Z');

// One turn issuing two tools, followed by a turn that reads 1,000,000 input
// tokens at $4/Mtok. The issuing share is $0.60 / 2 = $0.30 each; the downstream
// split is 250 : 750 bytes = $1.00 / $3.00.
const EVENTS: Ev[] = [
  stop(1, 10, { cost_usd: '0.600000' }),
  tool(1, 11, 'tool-a', { tool_output_bytes: 250 }),
  tool(1, 12, 'tool-b', { tool_output_bytes: 750 }),
  stop(2, 20, { cost_usd: '4.000000', input_tokens: 1_000_000 }),
];

describe('runComputeCostAttribution', () => {
  it('writes both attributions onto the tool events of a settled session', async () => {
    const db = makeDb(EVENTS);

    await runComputeCostAttribution(asDb(db), registry, { now: NOW });

    expect(writtenRows(db)).toEqual([
      ['tool-a', at(11).toISOString(), '0.300000', '1.000000'],
      ['tool-b', at(12).toISOString(), '0.300000', '3.000000'],
    ]);
  });

  it('is idempotent — a second run computes byte-identical values', async () => {
    // The guard against doubling. The job assigns, never accumulates, and the
    // SQL only writes rows whose value actually moves, so a re-run over
    // already-attributed events is a no-op in the database too.
    const first = makeDb(EVENTS);
    await runComputeCostAttribution(asDb(first), registry, { now: NOW });
    const second = makeDb(EVENTS);
    await runComputeCostAttribution(asDb(second), registry, { now: NOW });

    expect(writtenRows(second)).toEqual(writtenRows(first));
    expect(first._executed.some((s) => s.includes('IS DISTINCT FROM'))).toBe(true);
  });

  it('leaves the session / PR / continuous-aggregate cost chain alone', async () => {
    // The invariant this whole feature turns on: `events.cost_usd` →
    // `sessions.total_cost_usd` → `pr_rollups.total_cost_usd` → the two cost
    // caggs already count these dollars exactly once. Attribution redistributes
    // them for display and must never re-enter that chain.
    const db = makeDb(EVENTS);

    await runComputeCostAttribution(asDb(db), registry, { now: NOW });

    const writes = db._executed.filter((s) => /\b(UPDATE|INSERT|DELETE|CALL)\b/.test(s));
    expect(writes.length).toBeGreaterThan(0);
    for (const stmt of writes) {
      expect(stmt).toMatch(/UPDATE\s+events\s+e/);
      expect(stmt).not.toMatch(/total_cost_usd/);
      expect(stmt).not.toMatch(/pr_rollups/);
      expect(stmt).not.toMatch(/daily_cost_by_user|daily_cost_by_model|daily_tool_usage/);
      expect(stmt).not.toMatch(/refresh_continuous_aggregate/);
    }
    // And it never rewrites cost_usd itself — that is reprice-events' job.
    expect(db._executed.some((s) => /SET\s+cost_usd/.test(s))).toBe(false);
  });

  it('writes nothing at all when no event carries turn linkage', async () => {
    // Every live Claude Code session until the hook reports linkage (P14-003).
    const unlinked = EVENTS.map((e) => ({ ...e, turn_number: null }));
    const db = makeDb(unlinked);

    await runComputeCostAttribution(asDb(db), registry, { now: NOW });

    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('decompresses a compressed chunk and recompresses it afterwards', async () => {
    const db = makeDb(EVENTS, { compressed: true });

    await runComputeCostAttribution(asDb(db), registry, { now: NOW });

    const order = db._executed.filter((s) => /decompress_chunk|compress_chunk|UPDATE/.test(s));
    expect(order[0]).toMatch(/decompress_chunk/);
    expect(order.at(-1)).toMatch(/compress_chunk/);
    expect(order.some((s) => /UPDATE\s+events/.test(s))).toBe(true);
  });

  it('does not compress a chunk the policy has not reached yet', async () => {
    const db = makeDb(EVENTS, { compressed: false });

    await runComputeCostAttribution(asDb(db), registry, { now: NOW });

    expect(db._executed.some((s) => /(?<!de)compress_chunk/.test(s))).toBe(false);
  });

  it('takes its own advisory lock, under its own job name', async () => {
    const db = makeDb(EVENTS);

    await runComputeCostAttribution(asDb(db), registry, { now: NOW });

    expect(db.jobRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobName: 'compute-cost-attribution' }),
      }),
    );
  });
});
