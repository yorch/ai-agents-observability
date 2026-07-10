import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

const mockPrisma = {
  $queryRaw: vi.fn(),
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
  Prisma: {
    empty: { strings: [''], values: [] },
    join: (values: unknown[]) => ({ strings: [], values }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

beforeEach(() => {
  mockPrisma.$queryRaw.mockReset();
});

describe('getOutcomesByFrictionBand', () => {
  it('maps band rows and orders low → medium → high', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { avg_cost: 9.5, band: 'high', bug_linked: 3n, ci_failed: 4n, merged_prs: 12n, reverted: 2n },
      { avg_cost: 3.1, band: 'low', bug_linked: 1n, ci_failed: 2n, merged_prs: 40n, reverted: 1n },
      {
        avg_cost: null,
        band: 'medium',
        bug_linked: 0n,
        ci_failed: 1n,
        merged_prs: 8n,
        reverted: 0n,
      },
    ]);

    const { getOutcomesByFrictionBand } = await import('../src/lib/quality-queries.js');
    const rows = await getOutcomesByFrictionBand(new Date('2026-01-01'));

    expect(rows.map((r) => r.band)).toEqual(['low', 'medium', 'high']);
    expect(rows[2]).toEqual({
      avgCostUsd: 9.5,
      band: 'high',
      bugLinked: 3,
      ciFailed: 4,
      mergedPrs: 12,
      reverted: 2,
    });
    // Null avg cost (no rollups in the band) coerces to 0.
    expect(rows[1]?.avgCostUsd).toBe(0);
  });
});

describe('getDefectAttributions', () => {
  it('maps bug → origin rows with spend and link phrase', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        bug_created_at: new Date('2026-02-01T00:00:00Z'),
        bug_key: 'OBS-99',
        bug_status: 'Open',
        bug_summary: 'Widget crashes',
        link_phrase: 'is caused by',
        origin_key: 'OBS-42',
        origin_merged: 2n,
        origin_spend: 14.25,
      },
    ]);

    const { getDefectAttributions } = await import('../src/lib/quality-queries.js');
    const rows = await getDefectAttributions(new Date('2026-01-01'));

    expect(rows).toEqual([
      {
        bugCreatedAt: new Date('2026-02-01T00:00:00Z'),
        bugKey: 'OBS-99',
        bugStatus: 'Open',
        bugSummary: 'Widget crashes',
        linkPhrase: 'is caused by',
        originKey: 'OBS-42',
        originMergedPrs: 2,
        originSpendUsd: 14.25,
      },
    ]);
  });
});
