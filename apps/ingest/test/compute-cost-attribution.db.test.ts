import { createClient, type PrismaClient } from '@ai-agents-observability/db';
import type { PriceTable } from '@ai-agents-observability/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type CostAttributionDb,
  runComputeCostAttribution,
} from '../src/jobs/compute-cost-attribution';
import type { PriceTableRegistry } from '../src/lib/price-tables';

/**
 * The parts of P14-004 a mock cannot reach: that
 * `0003_tool_cost_attribution.sql` actually applied, that the two new columns
 * are visible through the `interactive_events` view (they are not, unless that
 * migration redefined it — `SELECT *` is expanded at view-creation time), that a
 * compressed chunk can be decompressed / written / recompressed, and that
 * Postgres' NUMERIC(12,6) stores the number JS computed.
 *
 * Skips when `DATABASE_URL` is unset — the same gate
 * `reprice-events.db.test.ts` and `packages/db/test/schema.test.ts` use.
 */

const errors: unknown[] = [];
const logger = {
  error: (...args: unknown[]) => errors.push(args),
  info: () => {},
  warn: () => {},
} as unknown as NonNullable<Parameters<typeof runComputeCostAttribution>[2]>['logger'];

function expectNoJobErrors(): void {
  // withJobRun catches and logs, so a broken statement would otherwise show up
  // as "nothing changed" rather than as a failure.
  expect(errors.map((e) => JSON.stringify(e))).toEqual([]);
}

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('runComputeCostAttribution (against a real Timescale)', () => {
  let prisma: PrismaClient;

  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = '00000000-0000-4000-8000-0000000f1001';
  const sessionId = '00000000-0000-4000-8000-0000000f1002';
  // Old enough that the 7-day compression policy applies, so the
  // decompress/recompress path is exercised rather than skipped.
  const ts = new Date('2026-01-20T12:00:00Z');
  const at = (m: number) => new Date(ts.getTime() + m * 60_000);

  // $4/Mtok input, $1 cache read, $10 cache write.
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

  const toolA = '00000000-0000-4000-8000-0000000f100a';
  const toolB = '00000000-0000-4000-8000-0000000f100b';

  async function attribution(): Promise<
    { attributed_cost_usd: string | null; downstream_cost_usd: string | null; event_id: string }[]
  > {
    // Read through the VIEW on purpose: this is what the dashboards read, and a
    // migration that added the columns without replacing the view would return
    // "column does not exist" here and pass every mocked test.
    return prisma.$queryRaw`
      SELECT event_id, attributed_cost_usd::text, downstream_cost_usd::text
      FROM interactive_events
      WHERE session_id = ${sessionId}::uuid AND event_type = 'PostToolUse'
      ORDER BY ts
    `;
  }

  async function insertEvent(
    eventId: string,
    minute: number,
    eventType: string,
    turn: number,
    extra: { bytes?: number; cost?: number; inputTokens?: number },
  ): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO events (
        event_id, session_id, user_id, ts, agent_type, event_type,
        turn_number, tool_name, tool_output_bytes, model, input_tokens, cost_usd
      ) VALUES (
        ${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${at(minute)},
        'CLAUDE_CODE', ${eventType}, ${turn},
        ${eventType === 'PostToolUse' ? 'Read' : null},
        ${extra.bytes ?? null}, ${eventType === 'Stop' ? 'test-model' : null},
        ${extra.inputTokens ?? null}, ${extra.cost ?? null}
      )
    `;
  }

  beforeAll(async () => {
    prisma = createClient(DATABASE_URL as string);

    await prisma.$executeRaw`DELETE FROM events WHERE session_id = ${sessionId}::uuid`;
    await prisma.session.deleteMany({ where: { sessionId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    await prisma.user.create({
      data: { displayName: `attr ${suffix}`, githubLogin: `attr-${suffix}`, id: userId },
    });
    await prisma.session.create({
      data: {
        agentType: 'CLAUDE_CODE',
        cwd: '/tmp',
        endedAt: at(30),
        lastEventAt: at(30),
        sessionId,
        startedAt: ts,
        status: 'COMPLETED',
        totalCostUsd: 4.6,
        userId,
      },
    });

    // Turn 1 costs $0.60 and issues two tools (250 and 750 output bytes).
    // Turn 2 reads 1,000,000 input tokens = $4.00 input-side.
    await insertEvent('00000000-0000-4000-8000-0000000f1011', 10, 'Stop', 1, { cost: 0.6 });
    await insertEvent(toolA, 11, 'PostToolUse', 1, { bytes: 250 });
    await insertEvent(toolB, 12, 'PostToolUse', 1, { bytes: 750 });
    await insertEvent('00000000-0000-4000-8000-0000000f1012', 20, 'Stop', 2, {
      cost: 4,
      inputTokens: 1_000_000,
    });

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

  it('writes both attributions through a compressed chunk, and recompresses it', async () => {
    const compressedBefore = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM timescaledb_information.chunks
      WHERE hypertable_name = 'events' AND is_compressed
    `;
    expect(Number(compressedBefore[0]?.n ?? 0)).toBeGreaterThan(0);

    // Wide lookback: the fixture is deliberately old enough to be compressed.
    await runComputeCostAttribution(prisma as unknown as CostAttributionDb, registry, {
      logger,
      lookbackDays: 3650,
    });
    expectNoJobErrors();

    const rows = await attribution();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.event_id).toBe(toolA);
    expect(Number(rows[0]?.attributed_cost_usd)).toBeCloseTo(0.3, 6);
    expect(Number(rows[0]?.downstream_cost_usd)).toBeCloseTo(1, 6);
    expect(Number(rows[1]?.attributed_cost_usd)).toBeCloseTo(0.3, 6);
    expect(Number(rows[1]?.downstream_cost_usd)).toBeCloseTo(3, 6);

    const compressedAfter = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM timescaledb_information.chunks
      WHERE hypertable_name = 'events' AND is_compressed
    `;
    expect(Number(compressedAfter[0]?.n ?? 0)).toBe(Number(compressedBefore[0]?.n ?? 0));
  });

  it('leaves the session total and the cost aggregates untouched', async () => {
    // The invariant. `sessions.total_cost_usd` is accumulated at ingest and this
    // job must not have moved it, and `events.cost_usd` must still be the only
    // thing the caggs sum.
    const session = await prisma.session.findUnique({ where: { sessionId } });
    expect(Number(session?.totalCostUsd)).toBeCloseTo(4.6, 6);

    const [row] = await prisma.$queryRaw<{ total: string | null }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM events WHERE session_id = ${sessionId}::uuid
    `;
    expect(Number(row?.total)).toBeCloseTo(4.6, 6);
  });

  it('is idempotent — a second run writes no rows', async () => {
    const before = await attribution();

    await runComputeCostAttribution(prisma as unknown as CostAttributionDb, registry, {
      logger,
      lookbackDays: 3650,
    });
    expectNoJobErrors();

    expect(await attribution()).toEqual(before);
  });

  it('attributes nothing to a session with no turn linkage', async () => {
    const unlinked = '00000000-0000-4000-8000-0000000f1003';
    await prisma.$executeRaw`
      INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type, tool_name)
      VALUES (${unlinked}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${at(40)},
              'CLAUDE_CODE', 'PostToolUse', 'Read')
    `;

    await runComputeCostAttribution(prisma as unknown as CostAttributionDb, registry, {
      logger,
      lookbackDays: 3650,
    });
    expectNoJobErrors();

    const [row] = await prisma.$queryRaw<
      { attributed_cost_usd: string | null; downstream_cost_usd: string | null }[]
    >`
      SELECT attributed_cost_usd::text, downstream_cost_usd::text
      FROM events WHERE event_id = ${unlinked}::uuid
    `;
    expect(row?.attributed_cost_usd).toBeNull();
    expect(row?.downstream_cost_usd).toBeNull();
  });
});
