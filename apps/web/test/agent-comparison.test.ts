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
  // Identity: these suites assert on the mock client's calls. That the real
  // extension actually filters is proven by test/run-kind-coverage.test.ts
  // and against a live database, not here.
  withInteractiveOnly: <T>(c: T): T => c,
}));

beforeEach(() => {
  mockPrisma.$queryRaw.mockReset();
});

describe('getAgentTypeComparison', () => {
  it('derives avg cost, error rate, prompts and total tokens per agent', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        agent_type: 'CLAUDE_CODE',
        input_tokens: 800_000n,
        median_friction: 0.2,
        output_tokens: 200_000n,
        prompts: 42n,
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
    expect(r?.prompts).toBe(42);
  });

  it('nulls friction and error rate when there is no scored/tool-call data', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        agent_type: 'CODEX',
        input_tokens: 0n,
        median_friction: null,
        output_tokens: 0n,
        prompts: 3n,
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
  });

  // P14-015. Cost is derived from token counts, so an agent that reported no
  // tokens reported nothing cost could come from — its zero is the absence of a
  // measurement. Rendering that as "$0.00" next to a genuinely measured agent
  // says the unmeasured one is free. Copilot CLI is the live case (P14-007: no
  // hook payload carries usage), but the rule is keyed on the data, so any
  // adapter with a capture gap gets it.
  it('reports cost as unknown, not zero, for an agent that reported no tokens', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        agent_type: 'COPILOT',
        input_tokens: 0n,
        median_friction: 0.4,
        output_tokens: 0n,
        prompts: 180n,
        sessions: 20n,
        tool_calls: 300n,
        tool_errors: 9n,
        total_cost: 0,
      },
    ]);

    const { getAgentTypeComparison } = await import('../src/lib/org-queries.js');
    const rows = await getAgentTypeComparison(new Date('2026-01-01'));

    expect(rows[0]?.totalCostUsd).toBeNull();
    expect(rows[0]?.avgCostUsd).toBeNull();
    // Everything measurable without usage capture survives — the row is not
    // blanked, it is scoped to what the data supports.
    expect(rows[0]?.prompts).toBe(180);
    expect(rows[0]?.sessions).toBe(20);
    expect(rows[0]?.toolErrorRate).toBeCloseTo(0.03);
    expect(rows[0]?.medianFriction).toBeCloseTo(0.4);
  });

  it('keeps a real $0 when tokens were reported but priced at nothing', async () => {
    // The other way an agent reaches zero: usage WAS captured, and the price
    // table had no row for the model. That is a genuine measured $0 with its own
    // surface (/admin/price-tables "Unpriced models"), and it must not be
    // laundered into "unknown" — doing so would hide the missing price row.
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        agent_type: 'PI',
        input_tokens: 500_000n,
        median_friction: null,
        output_tokens: 100_000n,
        prompts: 7n,
        sessions: 4n,
        tool_calls: 10n,
        tool_errors: 0n,
        total_cost: 0,
      },
    ]);

    const { getAgentTypeComparison } = await import('../src/lib/org-queries.js');
    const rows = await getAgentTypeComparison(new Date('2026-01-01'));

    expect(rows[0]?.totalCostUsd).toBe(0);
    expect(rows[0]?.avgCostUsd).toBe(0);
  });
});
