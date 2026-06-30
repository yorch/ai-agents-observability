import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

// ── Mock @ai-agents-observability/db ────────────────────────────────────────
// The query layer calls Prisma.sql / Prisma.empty at runtime, so the mock must
// provide a working stub (the mock $queryRaw ignores the built SQL).

const mockPrisma = {
  $queryRaw: vi.fn(),
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
  Prisma: {
    empty: { strings: [''], values: [] },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

function row(overrides: Record<string, unknown> = {}) {
  return {
    ended_at: new Date('2026-01-15T09:30:00Z'),
    friction_score: null,
    interrupt_count: 0,
    permission_deny_count: 0,
    shape_label: null,
    started_at: new Date('2026-01-15T09:00:00Z'),
    status: 'COMPLETED',
    tool_call_count: 0,
    tool_error_count: 0,
    user_message_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockPrisma.$queryRaw.mockReset();
});

// ── getUserEffectiveness ──────────────────────────────────────────────────────

describe('getUserEffectiveness', () => {
  it('uses the stored friction_score when present and averages per day', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      row({ friction_score: 0.2, shape_label: 'exploratory', tool_call_count: 5 }),
      row({ friction_score: 0.4, shape_label: 'debugging', tool_call_count: 5 }),
    ]);

    const { getUserEffectiveness } = await import('../src/lib/effectiveness-queries.js');
    const result = await getUserEffectiveness('u1', { since: new Date('2026-01-01') });

    expect(result.trend).toHaveLength(1);
    expect(result.trend[0]?.date).toBe('2026-01-15');
    expect(result.trend[0]?.frictionScore).toBeCloseTo(0.3); // (0.2 + 0.4) / 2
    expect(result.shapeHistogram).toEqual({ debugging: 1, exploratory: 1 });
    expect(result.scoredSessionCount).toBe(2);
  });

  it('falls back to on-the-fly computation when friction_score is null but data is sufficient', async () => {
    // null stored score; 4 tool calls, 2 errors → errorRate 0.5 * 0.30 weight = 0.15.
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      row({
        friction_score: null,
        shape_label: 'debugging',
        tool_call_count: 4,
        tool_error_count: 2,
        user_message_count: 2,
      }),
    ]);

    const { getUserEffectiveness } = await import('../src/lib/effectiveness-queries.js');
    const result = await getUserEffectiveness('u1', { since: new Date('2026-01-01') });

    expect(result.scoredSessionCount).toBe(1);
    expect(result.trend[0]?.frictionScore).toBeCloseTo(0.15);
  });

  it('decomposes friction into mean weighted source contributions', async () => {
    // 4 calls, 2 errors → errorRate 0.5 * 0.30 = 0.15; 2 denies → denyRate 0.5 * 0.30 = 0.15.
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      row({
        friction_score: null,
        permission_deny_count: 2,
        shape_label: 'debugging',
        tool_call_count: 4,
        tool_error_count: 2,
        user_message_count: 2,
      }),
    ]);

    const { getUserEffectiveness } = await import('../src/lib/effectiveness-queries.js');
    const result = await getUserEffectiveness('u1', { since: new Date('2026-01-01') });

    expect(result.sources.error).toBeCloseTo(0.15);
    expect(result.sources.denial).toBeCloseTo(0.15);
    expect(result.sources.interrupt).toBeCloseTo(0);
    expect(result.sources.abandonment).toBeCloseTo(0);
  });

  it('returns zeroed sources when there are no scored sessions', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    const { getUserEffectiveness } = await import('../src/lib/effectiveness-queries.js');
    const result = await getUserEffectiveness('u1', { since: new Date('2026-01-01') });

    expect(result.sources).toEqual({ abandonment: 0, denial: 0, error: 0, interrupt: 0 });
  });

  it('excludes insufficient-data sessions from the trend (null, not zero)', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      // toolCallCount < 2 AND userMessageCount < 2 → computeFrictionScore null.
      row({ friction_score: null, tool_call_count: 0, user_message_count: 1 }),
    ]);

    const { getUserEffectiveness } = await import('../src/lib/effectiveness-queries.js');
    const result = await getUserEffectiveness('u1', { since: new Date('2026-01-01') });

    expect(result.trend).toHaveLength(0);
    expect(result.scoredSessionCount).toBe(0);
  });

  it('returns empty structures for an all-null, no-session dataset', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    const { getUserEffectiveness } = await import('../src/lib/effectiveness-queries.js');
    const result = await getUserEffectiveness('u1', { since: new Date('2026-01-01') });

    expect(result.trend).toEqual([]);
    expect(result.shapeHistogram).toEqual({});
    expect(result.scoredSessionCount).toBe(0);
  });
});

// ── distribution helpers ──────────────────────────────────────────────────────

describe('getOrgEffectivenessDistribution', () => {
  it('returns percentiles and shape-mix counts', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ count: 10n, p25: 0.1, p50: 0.3, p75: 0.6 }])
      .mockResolvedValueOnce([
        { count: 3n, shape_label: 'exploratory' },
        { count: 1n, shape_label: 'debugging' },
      ]);

    const { getOrgEffectivenessDistribution } = await import('../src/lib/effectiveness-queries.js');
    const result = await getOrgEffectivenessDistribution({ since: new Date('2026-01-01') });

    expect(result.friction).toEqual({ p25: 0.1, p50: 0.3, p75: 0.6 });
    expect(result.scoredSessions).toBe(10);
    // shapeMix is integer session counts (NOT proportions) — see EffectivenessDistribution.
    expect(result.shapeMix.exploratory).toBe(3);
    expect(result.shapeMix.debugging).toBe(1);
  });

  it('returns null friction when no session has a score', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ count: 0n, p25: null, p50: null, p75: null }])
      .mockResolvedValueOnce([]);

    const { getOrgEffectivenessDistribution } = await import('../src/lib/effectiveness-queries.js');
    const result = await getOrgEffectivenessDistribution({ since: new Date('2026-01-01') });

    expect(result.friction).toBeNull();
    expect(result.scoredSessions).toBe(0);
    expect(result.shapeMix).toEqual({});
  });
});

describe('getTeamEffectivenessDistribution', () => {
  it('short-circuits to an empty distribution for an empty cohort (no SQL)', async () => {
    const { getTeamEffectivenessDistribution } = await import(
      '../src/lib/effectiveness-queries.js'
    );
    const result = await getTeamEffectivenessDistribution([], { since: new Date('2026-01-01') });

    expect(result).toEqual({ friction: null, scoredSessions: 0, shapeMix: {} });
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});
