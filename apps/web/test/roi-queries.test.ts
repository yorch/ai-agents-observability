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
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

beforeEach(() => {
  mockPrisma.$queryRaw.mockReset();
});

describe('getOrgRoiSummary', () => {
  it('derives cost-per-merged-PR, reverted share, and CI-clean rate', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        ci_failed_merged_prs: 2n,
        clean_merged_prs: 8n,
        merged_prs: 10n,
        merged_spend: 50,
        reverted_prs: 1n,
        reverted_spend: 12,
        total_spend: 60,
      },
    ]);

    const { getOrgRoiSummary } = await import('../src/lib/roi-queries.js');
    const r = await getOrgRoiSummary(new Date('2026-01-01'));

    expect(r.totalSpendUsd).toBe(60);
    expect(r.mergedPrs).toBe(10);
    expect(r.costPerMergedPr).toBeCloseTo(5); // 50 / 10
    expect(r.revertedSpendUsd).toBe(12);
    expect(r.revertedSpendShare).toBeCloseTo(0.2); // 12 / 60
    expect(r.revertedPrs).toBe(1);
    expect(r.ciCleanMergeRate).toBeCloseTo(0.8); // 8 / 10
  });

  it('avoids division by zero with no merged PRs or spend', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        ci_failed_merged_prs: 0n,
        clean_merged_prs: 0n,
        merged_prs: 0n,
        merged_spend: 0,
        reverted_prs: 0n,
        reverted_spend: 0,
        total_spend: 0,
      },
    ]);

    const { getOrgRoiSummary } = await import('../src/lib/roi-queries.js');
    const r = await getOrgRoiSummary(new Date('2026-01-01'));

    expect(r.costPerMergedPr).toBe(0);
    expect(r.revertedSpendShare).toBe(0);
    expect(r.ciCleanMergeRate).toBe(0);
  });
});

describe('getCiCostCorrelation', () => {
  it('maps clean vs CI-failed counts and average costs', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { clean_avg_cost: 1.5, clean_count: 20n, failed_avg_cost: 4.2, failed_count: 5n },
    ]);

    const { getCiCostCorrelation } = await import('../src/lib/roi-queries.js');
    const r = await getCiCostCorrelation(new Date('2026-01-01'));

    expect(r.cleanCount).toBe(20);
    expect(r.cleanAvgCost).toBeCloseTo(1.5);
    expect(r.failedCount).toBe(5);
    expect(r.failedAvgCost).toBeCloseTo(4.2);
  });

  it('coerces null averages (no rows in a bucket) to 0', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { clean_avg_cost: null, clean_count: 0n, failed_avg_cost: null, failed_count: 0n },
    ]);

    const { getCiCostCorrelation } = await import('../src/lib/roi-queries.js');
    const r = await getCiCostCorrelation(new Date('2026-01-01'));

    expect(r.cleanAvgCost).toBe(0);
    expect(r.failedAvgCost).toBe(0);
  });
});

describe('getSpendByJiraKey', () => {
  it('maps Jira-key spend rows', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { jira_key: 'PROJ-1', merged_prs: 3n, pr_count: 4n, total_cost: 9.5 },
      { jira_key: 'PROJ-2', merged_prs: 1n, pr_count: 1n, total_cost: 2 },
    ]);

    const { getSpendByJiraKey } = await import('../src/lib/roi-queries.js');
    const rows = await getSpendByJiraKey(new Date('2026-01-01'));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ jiraKey: 'PROJ-1', mergedPrs: 3, prCount: 4, totalCostUsd: 9.5 });
    expect(rows[1]?.totalCostUsd).toBe(2);
  });
});

describe('getRoiByRepo', () => {
  it('derives per-repo cost/PR, revert rate, and CI-clean rate', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        clean_merged_prs: 3n,
        merged_prs: 4n,
        merged_spend: 20,
        repo_name: 'web',
        repo_owner: 'acme',
        reverted_prs: 1n,
      },
    ]);

    const { getRoiByRepo } = await import('../src/lib/roi-queries.js');
    const rows = await getRoiByRepo(new Date('2026-01-01'));

    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.repoOwner).toBe('acme');
    expect(r?.repoName).toBe('web');
    expect(r?.mergedPrs).toBe(4);
    expect(r?.costPerMergedPr).toBeCloseTo(5); // 20 / 4
    expect(r?.revertRate).toBeCloseTo(0.25); // 1 / 4
    expect(r?.ciCleanRate).toBeCloseTo(0.75); // 3 / 4
  });
});
