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

describe('getAgentTypeComparison', () => {
  it('derives avg cost, error rate, and total tokens per agent', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        agent_type: 'CLAUDE_CODE',
        input_tokens: 800_000n,
        median_friction: 0.2,
        output_tokens: 200_000n,
        sessions: 10n,
        tool_calls: 100n,
        tool_errors: 5n,
        total_cost: 50,
      },
    ]);

    const { getAgentTypeComparison } = await import('../src/lib/org-queries.js');
    const rows = await getAgentTypeComparison(new Date('2026-01-01'));

    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.agentType).toBe('CLAUDE_CODE');
    expect(r?.avgCostUsd).toBeCloseTo(5); // 50 / 10
    expect(r?.medianFriction).toBeCloseTo(0.2);
    expect(r?.toolErrorRate).toBeCloseTo(0.05); // 5 / 100
    expect(r?.totalTokens).toBe(1_000_000);
  });

  it('nulls friction and error rate when there is no scored/tool-call data', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        agent_type: 'CODEX',
        input_tokens: 0n,
        median_friction: null,
        output_tokens: 0n,
        sessions: 2n,
        tool_calls: 0n,
        tool_errors: 0n,
        total_cost: 0,
      },
    ]);

    const { getAgentTypeComparison } = await import('../src/lib/org-queries.js');
    const rows = await getAgentTypeComparison(new Date('2026-01-01'));

    expect(rows[0]?.medianFriction).toBeNull();
    expect(rows[0]?.toolErrorRate).toBeNull();
    expect(rows[0]?.avgCostUsd).toBe(0);
  });
});
