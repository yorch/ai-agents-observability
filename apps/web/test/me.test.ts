import { beforeEach, describe, expect, it, vi } from 'vitest';

// We need DATABASE_URL for the lazy prisma singleton
beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

// ── Mock @ai-agents-observability/db ────────────────────────────────────────

const mockPrisma = {
  $queryRaw: vi.fn(),
  session: {
    aggregate: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
  },
  visibilityPolicy: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
  // Minimal Prisma.sql tag so $queryRaw call sites don't blow up under mock.
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
}));

// ── getUsageSummary ──────────────────────────────────────────────────────────

describe('getUsageSummary', () => {
  it('returns zeroed summary when no sessions', async () => {
    mockPrisma.session.aggregate.mockResolvedValueOnce({
      _count: { sessionId: 0 },
      _sum: { totalCostUsd: null },
    });
    mockPrisma.session.findMany.mockResolvedValueOnce([]);

    const { getUsageSummary } = await import('../src/lib/me-queries.js');
    const result = await getUsageSummary('u1', new Date(0));

    expect(result.sessionCount).toBe(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalHours).toBe(0);
    expect(result.repoCount).toBe(0);
  });

  it('calculates totalHours from session durations', async () => {
    const start = new Date('2026-01-01T10:00:00Z');
    const end = new Date('2026-01-01T11:00:00Z'); // 1 hour

    mockPrisma.session.aggregate.mockResolvedValueOnce({
      _count: { sessionId: 1 },
      _sum: { totalCostUsd: '0.50' },
    });
    mockPrisma.session.findMany.mockResolvedValueOnce([
      { endedAt: end, repoId: 'repo1', startedAt: start },
    ]);

    const { getUsageSummary } = await import('../src/lib/me-queries.js');
    const result = await getUsageSummary('u1', new Date(0));

    expect(result.sessionCount).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.5);
    expect(result.totalHours).toBeCloseTo(1.0);
    expect(result.repoCount).toBe(1);
  });

  it('counts unique repos correctly', async () => {
    mockPrisma.session.aggregate.mockResolvedValueOnce({
      _count: { sessionId: 3 },
      _sum: { totalCostUsd: '1.00' },
    });
    mockPrisma.session.findMany.mockResolvedValueOnce([
      { endedAt: null, repoId: 'repo-a', startedAt: new Date() },
      { endedAt: null, repoId: 'repo-a', startedAt: new Date() }, // duplicate
      { endedAt: null, repoId: 'repo-b', startedAt: new Date() },
    ]);

    const { getUsageSummary } = await import('../src/lib/me-queries.js');
    const result = await getUsageSummary('u1', new Date(0));

    expect(result.repoCount).toBe(2);
  });
});

// ── getTopTools ──────────────────────────────────────────────────────────────

describe('getTopTools', () => {
  it('returns real per-tool counts from the events firehose', async () => {
    // Counts come from the events table (tool_name), not from primary_model.
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { call_count: 15n, tool_name: 'Edit' },
      { call_count: 3n, tool_name: 'Bash' },
    ]);

    const { getTopTools } = await import('../src/lib/me-queries.js');
    const result = await getTopTools('u1', new Date(0));

    expect(result[0]).toEqual({ callCount: 15, toolName: 'Edit' });
    expect(result[1]).toEqual({ callCount: 3, toolName: 'Bash' });
  });

  it('maps each returned row and coerces bigint counts to number', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { call_count: 5n, tool_name: 'Read' },
      { call_count: 4n, tool_name: 'Grep' },
    ]);

    const { getTopTools } = await import('../src/lib/me-queries.js');
    const result = await getTopTools('u1', new Date(0), 2);

    expect(result).toHaveLength(2);
    expect(typeof result[0]?.callCount).toBe('number');
  });
});

// ── getVisibilityPolicy ──────────────────────────────────────────────────────

describe('getVisibilityPolicy', () => {
  it('returns null when no policy exists', async () => {
    mockPrisma.visibilityPolicy.findUnique.mockResolvedValueOnce(null);

    const { getVisibilityPolicy } = await import('../src/lib/visibility.js');
    const result = await getVisibilityPolicy('u1');

    expect(result).toBeNull();
  });

  it('returns the policy when it exists', async () => {
    const policy = {
      shareMetadataWithOrg: true,
      shareMetadataWithTeam: true,
      shareTranscriptsWithOrg: false,
      shareTranscriptsWithTeam: false,
      updatedAt: new Date(),
      userId: 'u1',
    };
    mockPrisma.visibilityPolicy.findUnique.mockResolvedValueOnce(policy);

    const { getVisibilityPolicy } = await import('../src/lib/visibility.js');
    const result = await getVisibilityPolicy('u1');

    expect(result?.shareMetadataWithTeam).toBe(true);
    expect(result?.shareTranscriptsWithTeam).toBe(false);
  });
});

// ── updateVisibilityPolicy ───────────────────────────────────────────────────

describe('updateVisibilityPolicy', () => {
  it('calls upsert with the correct fields', async () => {
    mockPrisma.visibilityPolicy.upsert.mockResolvedValueOnce({
      shareMetadataWithOrg: false,
      shareMetadataWithTeam: true,
      shareTranscriptsWithOrg: false,
      shareTranscriptsWithTeam: true,
      updatedAt: new Date(),
      userId: 'u1',
    });

    const { updateVisibilityPolicy } = await import('../src/lib/visibility.js');
    await updateVisibilityPolicy('u1', {
      shareMetadataWithTeam: true,
      shareTranscriptsWithTeam: true,
    });

    expect(mockPrisma.visibilityPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ shareMetadataWithTeam: true }),
        where: { userId: 'u1' },
      }),
    );
  });
});
