import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GuardMetrics,
  PostPeriodActuals,
  ProjectionClaimType,
  StoredProjection,
} from '../src/lib/projections';
import {
  EMPTY_GUARD,
  GUARD_RISE_THRESHOLD,
  MIN_RANGE_FRACTION,
  PROJECTION_CLAIM_TYPES,
  PROJECTION_CLAIMS,
  rangeFrom,
  realizeProjection,
  startOfUtcDay,
} from '../src/lib/projections';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

/**
 * The mock deliberately exposes **no `upsert`**: `recordProjections` must reach
 * for `findMany` + `createMany` and nothing else. Restoring the upsert would
 * call an undefined method and every recording test here would fail loudly,
 * which is the point — the "first claim wins" rule below is a correctness rule,
 * not a style preference (see the comment in `recordProjections`).
 */
const mockPrisma = {
  projection: { createMany: vi.fn(), findMany: vi.fn() },
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
  Prisma: {
    empty: { strings: [''], values: [] },
    join: (values: unknown[]) => ({ strings: [], values }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
  // Identity: these suites assert on the mock client's calls. That the real
  // extension actually filters is proven by test/run-kind-coverage.test.ts
  // and against a live database, not here.
  withInteractiveOnly: <T>(c: T): T => c,
}));

beforeEach(() => {
  mockPrisma.projection.createMany.mockReset();
  mockPrisma.projection.findMany.mockReset();
});

type StoreRow = Record<string, unknown> & {
  claimType: string;
  periodStart: Date;
  segment: string;
};

function keyOf(row: { claimType: string; periodStart: Date; segment: string }): string {
  return `${row.claimType}|${row.segment}|${row.periodStart.toISOString()}`;
}

/**
 * A minimal stand-in for the `projections` table with its unique key on
 * `(claim_type, segment, period_start)`, so the tests below exercise what the
 * store would actually do rather than a canned return value. `seed` rows are
 * claims that already exist — the case the "never rewritten" rule is about.
 */
function installStore(seed: StoreRow[] = []): StoreRow[] {
  const store = [...seed];
  mockPrisma.projection.findMany.mockImplementation(
    async ({
      where,
    }: {
      where: { OR: { claimType: string; periodStart: Date; segment: string }[] };
    }) => store.filter((row) => where.OR.some((k) => keyOf(k) === keyOf(row))),
  );
  mockPrisma.projection.createMany.mockImplementation(
    async ({ data, skipDuplicates }: { data: StoreRow[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        if (skipDuplicates && store.some((existing) => keyOf(existing) === keyOf(row))) {
          continue;
        }
        store.push({ createdAt: PERIOD_START, id: `p${store.length + 1}`, ...row });
        count++;
      }
      return { count };
    },
  );
  return store;
}

const PERIOD_START = new Date('2026-06-01T00:00:00Z');
const PERIOD_END = new Date('2026-07-01T00:00:00Z');
const AFTER = new Date('2026-07-02T00:00:00Z');

const CALM: GuardMetrics = { frictionMean: 0.2, revertRate: 0.04, toolErrorRate: 0.05 };

function projection(over: Partial<StoredProjection> = {}): StoredProjection {
  return {
    baselineValue: 1000,
    baselineWindowDays: 30,
    claimType: 'routing_savings',
    createdAt: PERIOD_START,
    guardBaseline: CALM,
    id: 'p1',
    periodEnd: PERIOD_END,
    periodStart: PERIOD_START,
    projectedHigh: 400,
    projectedLow: 200,
    scorerVersions: { friction: 1 },
    segment: 'claude-opus-4',
    unit: 'usd',
    ...over,
  };
}

function actuals(over: Partial<PostPeriodActuals> = {}): PostPeriodActuals {
  return { actualValue: 700, guard: CALM, volume: 500, ...over };
}

describe('claim registry', () => {
  it('declares a complete definition for every claim', () => {
    expect(PROJECTION_CLAIM_TYPES.length).toBeGreaterThan(0);
    for (const type of PROJECTION_CLAIM_TYPES) {
      const claim = PROJECTION_CLAIMS[type];
      expect(claim.description.length).toBeGreaterThan(0);
      expect(['above', 'below']).toContain(claim.betterWhen);
      expect(['level', 'reduction']).toContain(claim.realizedQuantity);
      // Every claim must gate on volume, or "not yet measurable" is unreachable
      // and some segment will eventually render a delta from three rows.
      expect(claim.minPostPeriodVolume).toBeGreaterThan(0);
      expect(claim.volumeNoun.length).toBeGreaterThan(0);
    }
  });
});

describe('rangeFrom', () => {
  it('uses the spread between independent estimators', () => {
    const r = rangeFrom([100, 160]);
    expect(r.low).toBe(100);
    expect(r.high).toBe(160);
  });

  it('never produces a point estimate, even from one estimator', () => {
    // The whole discipline is ranges; a single estimator has no spread to
    // report, and writing it into both ends would be a point estimate wearing a
    // range's clothing.
    const r = rangeFrom([100]);
    expect(r.high).toBeGreaterThan(r.low);
    expect(r.high - r.low).toBeCloseTo(100 * MIN_RANGE_FRACTION, 6);
  });

  it('widens estimators that happen to agree', () => {
    const r = rangeFrom([100, 101]);
    expect(r.high - r.low).toBeGreaterThan(1);
  });

  it('never claims a negative floor', () => {
    expect(rangeFrom([0]).low).toBe(0);
    expect(rangeFrom([1]).low).toBeGreaterThanOrEqual(0);
  });

  it('is empty-safe', () => {
    expect(rangeFrom([])).toEqual({ high: 0, low: 0 });
    expect(rangeFrom([Number.NaN])).toEqual({ high: 0, low: 0 });
  });
});

describe('realizeProjection — refusing to answer', () => {
  it('says nothing while the period is still open', () => {
    const r = realizeProjection(projection(), actuals(), new Date('2026-06-15T00:00:00Z'));
    expect(r.status).toBe('period_open');
    expect(r.realizedValue).toBeNull();
    expect(r.actualValue).toBeNull();
  });

  it('reports "not yet measurable" below the volume floor rather than a delta', () => {
    const floor = PROJECTION_CLAIMS.routing_savings.minPostPeriodVolume;
    const r = realizeProjection(projection(), actuals({ volume: floor - 1 }), AFTER);
    expect(r.status).toBe('not_yet_measurable');
    expect(r.realizedValue).toBeNull();
    expect(r.reason).toContain('Not yet measurable');
    expect(r.reason).toContain('tool calls');
  });

  it('treats no rows at all the same as too few', () => {
    const r = realizeProjection(projection(), null, AFTER);
    expect(r.status).toBe('not_yet_measurable');
    expect(r.actualValue).toBeNull();
  });

  it('measures exactly at the floor', () => {
    const floor = PROJECTION_CLAIMS.routing_savings.minPostPeriodVolume;
    const r = realizeProjection(projection(), actuals({ volume: floor }), AFTER);
    expect(r.status).not.toBe('not_yet_measurable');
  });
});

describe('realizeProjection — comparing to the range', () => {
  it('scores a reduction claim against the drop from its baseline', () => {
    // Baseline 1000, actual 700 → realized reduction 300, inside 200–400.
    const r = realizeProjection(projection(), actuals({ actualValue: 700 }), AFTER);
    expect(r.realizedValue).toBe(300);
    expect(r.status).toBe('within_range');
    expect(r.wentBetterThanClaimed).toBe(false);
  });

  it('flags a reduction that fell short of the projected range', () => {
    const r = realizeProjection(projection(), actuals({ actualValue: 900 }), AFTER);
    expect(r.realizedValue).toBe(100);
    expect(r.status).toBe('below_range');
    expect(r.wentBetterThanClaimed).toBe(false);
  });

  it('credits a reduction that beat the projected range', () => {
    const r = realizeProjection(projection(), actuals({ actualValue: 400 }), AFTER);
    expect(r.status).toBe('above_range');
    expect(r.wentBetterThanClaimed).toBe(true);
  });

  it('scores a level claim against the value itself, not a delta', () => {
    const p = projection({
      baselineValue: 500,
      claimType: 'monthly_spend' as ProjectionClaimType,
      projectedHigh: 1200,
      projectedLow: 900,
      segment: 'org',
    });
    const r = realizeProjection(p, actuals({ actualValue: 1000, volume: 100 }), AFTER);
    expect(r.realizedValue).toBe(1000);
    expect(r.status).toBe('within_range');
  });

  it('reads "spent less than forecast" as the favourable direction for spend', () => {
    const p = projection({
      claimType: 'monthly_spend' as ProjectionClaimType,
      projectedHigh: 1200,
      projectedLow: 900,
      segment: 'org',
    });
    const r = realizeProjection(p, actuals({ actualValue: 500, volume: 100 }), AFTER);
    expect(r.status).toBe('below_range');
    expect(r.wentBetterThanClaimed).toBe(true);
  });
});

describe('realizeProjection — the outcome guard', () => {
  it('does not flag a win when outcomes held steady', () => {
    const r = realizeProjection(projection(), actuals({ actualValue: 400 }), AFTER);
    expect(r.wentBetterThanClaimed).toBe(true);
    expect(r.outcomeFlagged).toBe(false);
    expect(r.guardBreaches).toEqual([]);
  });

  it('flags a saving that came with a rise in reverts', () => {
    // The case P10-006 was written to catch: spend went down, quality went with
    // it. This must never render as a clean win.
    const worse: GuardMetrics = { ...CALM, revertRate: 0.24 };
    const r = realizeProjection(projection(), actuals({ actualValue: 400, guard: worse }), AFTER);
    expect(r.wentBetterThanClaimed).toBe(true);
    expect(r.outcomeFlagged).toBe(true);
    expect(r.guardBreaches.map((b) => b.metric)).toEqual(['revertRate']);
    expect(r.reason).toContain('not a clean win');
  });

  it('flags rises in friction and tool-error rate too', () => {
    const worse: GuardMetrics = {
      frictionMean: 0.5,
      revertRate: 0.04,
      toolErrorRate: 0.3,
    };
    const r = realizeProjection(projection(), actuals({ guard: worse }), AFTER);
    expect(r.guardBreaches.map((b) => b.metric).sort()).toEqual(['frictionMean', 'toolErrorRate']);
    expect(r.outcomeFlagged).toBe(true);
  });

  it('ignores movement inside the threshold', () => {
    // Exactly at the threshold is not "more than" it.
    const nudge: GuardMetrics = { ...CALM, frictionMean: 0.2 + GUARD_RISE_THRESHOLD };
    const r = realizeProjection(projection(), actuals({ guard: nudge }), AFTER);
    expect(r.guardBreaches).toEqual([]);
  });

  it('never treats an improvement as a breach', () => {
    const better: GuardMetrics = { frictionMean: 0.01, revertRate: 0, toolErrorRate: 0 };
    const r = realizeProjection(projection(), actuals({ guard: better }), AFTER);
    expect(r.guardBreaches).toEqual([]);
    expect(r.outcomeFlagged).toBe(false);
  });

  it('reports unmeasurable guard metrics instead of assuming they are fine', () => {
    const r = realizeProjection(
      projection({ guardBaseline: EMPTY_GUARD }),
      actuals({ guard: CALM }),
      AFTER,
    );
    expect(r.guardUnavailable.sort()).toEqual(['frictionMean', 'revertRate', 'toolErrorRate']);
    expect(r.guardBreaches).toEqual([]);
  });
});

describe('recording a claim', () => {
  it('normalizes a reversed range rather than storing it backwards', async () => {
    installStore();

    const { recordProjection } = await import('../src/lib/projections.js');
    const registered = await recordProjection({
      baselineValue: 1000,
      baselineWindowDays: 30,
      claimType: 'routing_savings',
      guardBaseline: CALM,
      periodEnd: PERIOD_END,
      periodStart: PERIOD_START,
      projectedHigh: 100,
      projectedLow: 400,
      segment: 'claude-opus-4',
    });

    expect(registered.projectedLow).toBe(100);
    expect(registered.projectedHigh).toBe(400);
  });

  it('records the versions active at claim time so the check replays fairly', async () => {
    installStore();

    const { recordProjection } = await import('../src/lib/projections.js');
    const registered = await recordProjection({
      baselineValue: 10,
      baselineWindowDays: 7,
      claimType: 'monthly_spend',
      guardBaseline: EMPTY_GUARD,
      periodEnd: PERIOD_END,
      periodStart: PERIOD_START,
      projectedHigh: 20,
      projectedLow: 10,
      segment: 'org',
    });

    expect(registered.scorerVersions).toHaveProperty('friction');
    expect(registered.scorerVersions).toHaveProperty('session_shape');
    expect(registered.unit).toBe('usd');
  });

  it('keys a claim on (claim, segment, period) and inserts it once', async () => {
    const store = installStore();

    const { recordProjection } = await import('../src/lib/projections.js');
    await recordProjection({
      baselineValue: 10,
      baselineWindowDays: 7,
      claimType: 'monthly_spend',
      guardBaseline: EMPTY_GUARD,
      periodEnd: PERIOD_END,
      periodStart: PERIOD_START,
      projectedHigh: 20,
      projectedLow: 10,
      segment: 'org',
    });

    // The read-back and the insert address the same key, and `skipDuplicates`
    // makes a concurrent render's loser a read rather than a second row.
    expect(mockPrisma.projection.findMany.mock.calls[0]?.[0]).toEqual({
      where: {
        OR: [{ claimType: 'monthly_spend', periodStart: PERIOD_START, segment: 'org' }],
      },
    });
    const create = mockPrisma.projection.createMany.mock.calls[0]?.[0];
    expect(create.skipDuplicates).toBe(true);
    expect(create.data).toHaveLength(1);
    expect(store).toHaveLength(1);
  });

  it('keeps the first claim for a key and never rewrites it on a later render', async () => {
    // The rule this file exists to protect. These pages are `force-dynamic`, and
    // the calendar-month claim keys on the month start — so an upsert here would
    // rewrite the row on every page view, and the "projection" checked against
    // actuals at month end would be the estimate made on the last day of the
    // month, when it already knew the answer. The claim would validate itself.
    const store = installStore([
      {
        baselineValue: 10,
        baselineWindowDays: 7,
        claimType: 'monthly_spend',
        createdAt: PERIOD_START,
        guardBaseline: {},
        id: 'first',
        metadata: {},
        periodEnd: PERIOD_END,
        periodStart: PERIOD_START,
        priceTableVersion: null,
        projectedHigh: 20,
        projectedLow: 10,
        scorerVersions: {},
        segment: 'org',
        unit: 'usd',
      },
    ]);

    const { recordProjection } = await import('../src/lib/projections.js');
    // A later render of the same page, now that the month is nearly over and the
    // estimate has narrowed onto the answer.
    const registered = await recordProjection({
      baselineValue: 999,
      baselineWindowDays: 7,
      claimType: 'monthly_spend',
      guardBaseline: EMPTY_GUARD,
      periodEnd: PERIOD_END,
      periodStart: PERIOD_START,
      projectedHigh: 1000,
      projectedLow: 990,
      segment: 'org',
    });

    // What is rendered is what was claimed at the time, not the fresh estimate.
    expect(registered.id).toBe('first');
    expect(registered.projectedLow).toBe(10);
    expect(registered.projectedHigh).toBe(20);
    expect(registered.baselineValue).toBe(10);
    // And nothing was written: a repeat view of a force-dynamic page is reads only.
    expect(mockPrisma.projection.createMany).not.toHaveBeenCalled();
    expect(store).toHaveLength(1);
  });

  it('still inserts a genuinely new key beside an existing claim', async () => {
    const store = installStore([
      {
        baselineValue: 10,
        baselineWindowDays: 7,
        claimType: 'monthly_spend',
        createdAt: PERIOD_START,
        guardBaseline: {},
        id: 'first',
        metadata: {},
        periodEnd: PERIOD_END,
        periodStart: PERIOD_START,
        priceTableVersion: null,
        projectedHigh: 20,
        projectedLow: 10,
        scorerVersions: {},
        segment: 'org',
        unit: 'usd',
      },
    ]);

    const { recordProjections } = await import('../src/lib/projections.js');
    const base = {
      baselineValue: 40,
      baselineWindowDays: 7,
      claimType: 'monthly_spend' as const,
      guardBaseline: EMPTY_GUARD,
      periodEnd: PERIOD_END,
      periodStart: PERIOD_START,
      projectedHigh: 60,
      projectedLow: 30,
    };
    const registered = await recordProjections([
      { ...base, segment: 'org' },
      // A different segment is a different claim, and a *later* period is a new
      // claim about the same segment — neither is the one already on the record.
      { ...base, segment: 'platform' },
      { ...base, periodStart: new Date('2026-07-01T00:00:00Z'), segment: 'org' },
    ]);

    const created = mockPrisma.projection.createMany.mock.calls[0]?.[0].data;
    expect(created).toHaveLength(2);
    expect(created.map((r: { segment: string }) => r.segment).sort()).toEqual(['org', 'platform']);
    expect(store).toHaveLength(3);
    expect(registered).toHaveLength(3);
    // The pre-existing claim came back untouched alongside the two new ones...
    expect(registered[0]?.id).toBe('first');
    expect(registered[0]?.projectedHigh).toBe(20);
    // ...in input order, which is how the routing page pairs a claim with the
    // recommendation it was made about.
    expect(registered.map((p) => p.segment)).toEqual(['org', 'platform', 'org']);
    expect(registered[2]?.periodStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('writes nothing when there is no claim to make', async () => {
    installStore();
    const { recordProjections } = await import('../src/lib/projections.js');
    await expect(recordProjections([])).resolves.toEqual([]);
    expect(mockPrisma.projection.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.projection.findMany).not.toHaveBeenCalled();
  });
});

describe('startOfUtcDay', () => {
  it('truncates so a rolling claim keys to one row per day, not per page view', () => {
    const a = startOfUtcDay(new Date('2026-08-13T09:15:00Z'));
    const b = startOfUtcDay(new Date('2026-08-13T23:59:59Z'));
    expect(a.toISOString()).toBe('2026-08-13T00:00:00.000Z');
    expect(a.getTime()).toBe(b.getTime());
  });
});
