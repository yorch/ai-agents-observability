import { createClient, type PrismaClient } from '@ai-agents-observability/db';
import type { PriceTable } from '@ai-agents-observability/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planReprice, type RepriceDb, runRepriceEvents } from '../src/jobs/reprice-events';
import type { PriceTableRegistry } from '../src/lib/price-tables';

// withJobRun catches and logs, so a broken statement would otherwise show up as
// "nothing changed" rather than a failure. Capture what the job logs and assert
// on it, so the suite fails where the fault is.
const errors: unknown[] = [];
const logger = {
  error: (...args: unknown[]) => errors.push(args),
  info: () => {},
  warn: () => {},
} as unknown as Parameters<typeof runRepriceEvents>[2] extends { logger?: infer L } ? L : never;

function expectNoJobErrors(): void {
  expect(errors.map((e) => JSON.stringify(e))).toEqual([]);
}

const DATABASE_URL = process.env.DATABASE_URL;

// The reprice job is almost entirely SQL, and the parts most likely to break are
// the ones a mock cannot reach: chunk-by-chunk decompression of a compressed
// hypertable, `CALL refresh_continuous_aggregate` (which cannot run inside a
// transaction), and whether Postgres' NUMERIC arithmetic lands on the number we
// expect. So this suite runs against a real Postgres-Timescale, and skips when
// DATABASE_URL is unset — the same gate packages/db/test/schema.test.ts uses.
//
// Shares the `events` hypertable with compute-cost-attribution.db.test.ts — see
// that file's header and tasks/P14-014-db-test-isolation.md for why the two
// must never decompress/recompress chunks concurrently, and how
// apps/ingest/vitest.config.ts now makes that automatic.
describe.skipIf(!DATABASE_URL)('runRepriceEvents (against a real Timescale)', () => {
  let prisma: PrismaClient;

  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = '00000000-0000-4000-8000-0000000f0001';
  const sessionId = '00000000-0000-4000-8000-0000000f0002';
  // Old enough that the 7-day compression policy applies, so the compressed-chunk
  // path is exercised rather than skipped.
  const ts = new Date('2026-01-15T12:00:00Z');

  // gpt-5.4 at the shipped rates: $2.50 in / $15 out / $0.25 cache read /
  // $2.50 cache write per Mtok.
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
  const registry: PriceTableRegistry = {
    forAgentParam: () => TABLE,
    resolve: () => TABLE,
  };

  // 1M input + 1M output + 1M cache read + 1M cache write.
  const EXPECTED = 2.5 + 15 + 0.25 + 2.5;

  async function events(): Promise<{ cost_usd: string }[]> {
    return prisma.$queryRaw`SELECT cost_usd FROM events WHERE session_id = ${sessionId}::uuid`;
  }

  beforeAll(async () => {
    prisma = createClient(DATABASE_URL as string);

    await prisma.$executeRaw`DELETE FROM events WHERE session_id = ${sessionId}::uuid`;
    await prisma.session.deleteMany({ where: { sessionId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    await prisma.user.create({
      data: {
        displayName: `reprice ${suffix}`,
        githubLogin: `reprice-${suffix}`,
        id: userId,
      },
    });
    await prisma.session.create({
      data: {
        agentType: 'CODEX',
        // Deliberately wrong, the way a session ingested under a stale table is.
        cwd: '/tmp',
        lastEventAt: ts,
        sessionId,
        startedAt: ts,
        status: 'COMPLETED',
        totalCostUsd: 999,
        userId,
      },
    });

    // Two events on the same model: one priced wrong, one already correct. The
    // second proves the IS DISTINCT FROM guard leaves settled rows alone.
    for (const [i, cost] of [999, EXPECTED].entries()) {
      await prisma.$executeRaw`
        INSERT INTO events (
          event_id, session_id, user_id, ts, agent_type, event_type,
          model, input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, cost_usd
        ) VALUES (
          gen_random_uuid(), ${sessionId}::uuid, ${userId}::uuid,
          ${new Date(ts.getTime() + i * 1000)}, 'CODEX', 'Stop',
          'gpt-5.4', 1000000, 1000000, 1000000, 1000000, ${cost}
        )
      `;
    }

    // Force the chunk closed and compressed so the decompress/recompress path is
    // the one under test, rather than an uncompressed happy path.
    await prisma.$executeRawUnsafe(`
      SELECT compress_chunk(c, if_not_compressed => true)
      FROM show_chunks('events', older_than => INTERVAL '7 days') c
    `);
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM events WHERE session_id = ${sessionId}::uuid`;
    await prisma.session.deleteMany({ where: { sessionId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('reports the delta without writing anything', async () => {
    const plan = await planReprice(prisma as unknown as RepriceDb, registry);
    const row = plan.rows.find((r) => r.model === 'gpt-5.4' && r.agentType === 'CODEX');

    expect(row).toBeDefined();
    expect(row?.events).toBe(2);
    // 999 + EXPECTED stored, 2 × EXPECTED correct.
    expect(row?.oldCostUsd).toBeCloseTo(999 + EXPECTED, 6);
    expect(row?.newCostUsd).toBeCloseTo(2 * EXPECTED, 6);

    await runRepriceEvents(prisma as unknown as RepriceDb, registry, { logger });
    expectNoJobErrors();

    const after = await events();
    expect(after.map((r) => Number(r.cost_usd)).sort((a, b) => a - b)).toEqual([EXPECTED, 999]);
  });

  it('rewrites events inside a compressed chunk and recompresses it', async () => {
    const compressedBefore = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM timescaledb_information.chunks
      WHERE hypertable_name = 'events' AND is_compressed
    `;
    expect(Number(compressedBefore[0]?.n ?? 0)).toBeGreaterThan(0);

    await runRepriceEvents(prisma as unknown as RepriceDb, registry, { apply: true, logger });
    expectNoJobErrors();

    const after = await events();
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(Number(row.cost_usd)).toBeCloseTo(EXPECTED, 6);
    }

    // The chunk must go back the way it was found — leaving history
    // decompressed would quietly multiply the storage this table is tuned for.
    const compressedAfter = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM timescaledb_information.chunks
      WHERE hypertable_name = 'events' AND is_compressed
    `;
    expect(Number(compressedAfter[0]?.n ?? 0)).toBe(Number(compressedBefore[0]?.n ?? 0));
  });

  it('recomputes the session total from the repriced events', async () => {
    const session = await prisma.session.findUnique({ where: { sessionId } });
    expect(Number(session?.totalCostUsd)).toBeCloseTo(2 * EXPECTED, 6);
  });

  it('refreshes the cost continuous aggregates', async () => {
    const rows = await prisma.$queryRaw<{ total_cost_usd: string }[]>`
      SELECT total_cost_usd FROM daily_cost_by_model
      WHERE model = 'gpt-5.4' AND agent_type = 'CODEX' AND day = time_bucket('1 day'::interval, ${ts}::timestamptz)
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_cost_usd)).toBeCloseTo(2 * EXPECTED, 6);
  });

  it('is idempotent — a second apply changes nothing', async () => {
    await runRepriceEvents(prisma as unknown as RepriceDb, registry, { apply: true, logger });
    expectNoJobErrors();
    const after = await events();
    for (const row of after) {
      expect(Number(row.cost_usd)).toBeCloseTo(EXPECTED, 6);
    }
  });

  it('leaves a model with no price row alone, and reports it', async () => {
    const empty: PriceTableRegistry = {
      forAgentParam: () => ({ generated_at: TABLE.generated_at, prices: {}, version: 'empty' }),
      resolve: () => ({ generated_at: TABLE.generated_at, prices: {}, version: 'empty' }),
    };
    const plan = await planReprice(prisma as unknown as RepriceDb, empty);

    expect(plan.rows).toHaveLength(0);
    expect(plan.unpriced.some((u) => u.model === 'gpt-5.4' && u.agentType === 'CODEX')).toBe(true);

    await runRepriceEvents(prisma as unknown as RepriceDb, empty, { apply: true, logger });
    expectNoJobErrors();
    const after = await events();
    for (const row of after) {
      expect(Number(row.cost_usd)).toBeCloseTo(EXPECTED, 6);
    }
  });
});
