import { deriveModelTiers, type ModelPolicySnapshot } from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';
import type { FrictionSources } from '../src/lib/effectiveness-queries';
import type {
  McpUsageRow,
  ToolPerfRow,
  UserCacheSummaryRow,
  UserModelRoutingRow,
} from '../src/lib/insights-queries';
import { buildRecommendations } from '../src/lib/recommendations';

const NO_FRICTION: FrictionSources = { abandonment: 0, denial: 0, error: 0, interrupt: 0 };

function toolPerf(overrides: Partial<ToolPerfRow> = {}): ToolPerfRow {
  return {
    attributedCostUsd: null,
    avgDurationMs: 100,
    avgInputBytes: null,
    avgOutputBytes: null,
    callCount: 10,
    deniedCount: 0,
    downstreamCostUsd: null,
    errorCount: 0,
    p95DurationMs: 200,
    toolCategory: null,
    toolName: 'Bash',
    ...overrides,
  };
}

function mcp(overrides: Partial<McpUsageRow> = {}): McpUsageRow {
  return {
    avgDurationMs: 100,
    callCount: 10,
    errorCount: 0,
    mcpServer: 'github',
    mcpTool: null,
    ...overrides,
  };
}

function cacheSummary(overrides: Partial<UserCacheSummaryRow> = {}): UserCacheSummaryRow {
  return {
    sessionCount: 8,
    totalCacheReadTokens: 200_000n,
    totalInputTokens: 500_000n,
    ...overrides,
  };
}

function modelRouting(overrides: Partial<UserModelRoutingRow> = {}): UserModelRoutingRow {
  return {
    agentType: 'CLAUDE_CODE',
    attributedCostUsd: 8,
    callCount: 40,
    model: 'claude-opus-4-8',
    toolCategory: 'fs_read',
    ...overrides,
  };
}

function rate(input: number, output: number) {
  return {
    cache_read_per_mtok: input / 10,
    cache_write_per_mtok: input * 1.25,
    input_per_mtok: input,
    output_per_mtok: output,
  };
}

// One agent's resolved policy, derived from real-shaped rates.
const PRICES = {
  'claude-haiku-4-5': rate(1, 5),
  'claude-opus-4-8': rate(15, 75),
  'claude-sonnet-5': rate(2, 10),
};
const POLICIES = new Map<string, ModelPolicySnapshot>([
  [
    'CLAUDE_CODE',
    {
      agentType: 'CLAUDE_CODE',
      allowedModels: [],
      cheapCategories: ['fs_read', 'search'],
      inputRates: Object.fromEntries(Object.entries(PRICES).map(([m, p]) => [m, p.input_per_mtok])),
      tiers: deriveModelTiers(PRICES),
    },
  ],
]);

describe('buildRecommendations', () => {
  it('returns nothing when there are no scored sessions', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [mcp({ errorCount: 9 })],
      modelRouting: [modelRouting()],
      policies: POLICIES,
      scoredSessionCount: 0,
      sources: { ...NO_FRICTION, error: 0.2 },
      toolPerf: [toolPerf({ deniedCount: 5 })],
    });
    expect(recs).toEqual([]);
  });

  it('flags frequently denied tools and marks it warn when denial dominates', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: { ...NO_FRICTION, denial: 0.2, error: 0.05 },
      toolPerf: [toolPerf({ deniedCount: 4, toolName: 'Bash' })],
    });
    const denial = recs.find((r) => r.id === 'permission-denials');
    expect(denial).toBeDefined();
    expect(denial?.severity).toBe('warn');
    expect(denial?.detail).toContain('Bash');
    expect(denial?.detail).toContain('4 permission prompts');
  });

  it('treats denials as info when another driver dominates', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: { ...NO_FRICTION, denial: 0.02, error: 0.25 },
      toolPerf: [toolPerf({ callCount: 4, deniedCount: 2, errorCount: 0 })],
    });
    expect(recs.find((r) => r.id === 'permission-denials')?.severity).toBe('info');
  });

  it('flags error-prone tools only above the call-count and rate thresholds', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [
        toolPerf({ callCount: 10, errorCount: 5, toolName: 'Bash' }), // 50% → flagged
        toolPerf({ callCount: 3, errorCount: 3, toolName: 'Edit' }), // <5 calls → ignored
        toolPerf({ callCount: 20, errorCount: 1, toolName: 'Read' }), // 5% → ignored
      ],
    });
    const ids = recs.map((r) => r.id);
    expect(ids).toContain('tool-errors:Bash');
    expect(ids).not.toContain('tool-errors:Edit');
    expect(ids).not.toContain('tool-errors:Read');
  });

  it('aggregates MCP tool rows to the server and flags flaky servers', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [
        mcp({ callCount: 6, errorCount: 3, mcpServer: 'github', mcpTool: 'create_pr' }),
        mcp({ callCount: 4, errorCount: 2, mcpServer: 'github', mcpTool: 'list_prs' }),
      ],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 5,
      sources: NO_FRICTION,
      toolPerf: [],
    });
    const server = recs.find((r) => r.id === 'mcp-errors:github');
    expect(server).toBeDefined();
    // 5 errors / 10 calls = 50%
    expect(server?.detail).toContain('50%');
  });

  it('surfaces an interrupt recommendation only when interrupts dominate', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: { ...NO_FRICTION, error: 0.05, interrupt: 0.12 },
      toolPerf: [],
    });
    expect(recs.find((r) => r.id === 'interrupts')).toBeDefined();
  });

  it('orders warnings before info recommendations', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: { ...NO_FRICTION, abandonment: 0.1, denial: 0.02 },
      toolPerf: [
        toolPerf({ callCount: 10, errorCount: 6, toolName: 'Bash' }), // warn
      ],
    });
    const severities = recs.map((r) => r.severity);
    const firstInfo = severities.indexOf('info');
    const lastWarn = severities.lastIndexOf('warn');
    if (firstInfo !== -1 && lastWarn !== -1) {
      expect(lastWarn).toBeLessThan(firstInfo);
    }
  });

  it('surfaces routing recommendation for premium retrieval-heavy usage', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      modelRouting: [
        modelRouting({
          attributedCostUsd: 9,
          callCount: 30,
          model: 'claude-opus-4-8',
          toolCategory: 'fs_read',
        }),
        modelRouting({
          attributedCostUsd: 7,
          callCount: 20,
          model: 'claude-opus-4-8',
          toolCategory: 'search',
        }),
        modelRouting({
          attributedCostUsd: 2,
          callCount: 10,
          model: 'claude-opus-4-8',
          toolCategory: 'exec',
        }),
      ],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [],
    });
    expect(recs.find((r) => r.id === 'routing:claude-opus-4-8')).toBeDefined();
  });

  it('surfaces cache recommendation when cache reuse is low with enough evidence', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary({
        sessionCount: 6,
        totalCacheReadTokens: 5_000n,
        totalInputTokens: 350_000n,
      }),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [],
    });
    expect(recs.find((r) => r.id === 'cache-efficiency')).toBeDefined();
  });

  it('suppresses the routing recommendation below the call and spend floors', () => {
    const thinCalls = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      // Spend clears the floor, call count does not.
      modelRouting: [modelRouting({ attributedCostUsd: 40, callCount: 24 })],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [],
    });
    expect(thinCalls.find((r) => r.id.startsWith('routing:'))).toBeUndefined();

    const thinSpend = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      // Call count clears the floor, spend does not.
      modelRouting: [modelRouting({ attributedCostUsd: 4.99, callCount: 400 })],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [],
    });
    expect(thinSpend.find((r) => r.id.startsWith('routing:'))).toBeUndefined();
  });

  it('never recommends routing away from a non-premium model', () => {
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      modelRouting: [
        modelRouting({ attributedCostUsd: 90, callCount: 500, model: 'claude-haiku-4-5' }),
      ],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [],
    });
    expect(recs.find((r) => r.id.startsWith('routing:'))).toBeUndefined();
  });

  it('suppresses the cache recommendation when reuse is healthy or evidence is thin', () => {
    const healthy = buildRecommendations({
      cacheSummary: cacheSummary({
        sessionCount: 20,
        totalCacheReadTokens: 400_000n,
        totalInputTokens: 600_000n,
      }),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [],
    });
    expect(healthy.find((r) => r.id === 'cache-efficiency')).toBeUndefined();

    // Low reuse, but too few sessions and too few input tokens to coach on.
    const thin = buildRecommendations({
      cacheSummary: cacheSummary({
        sessionCount: 2,
        totalCacheReadTokens: 10n,
        totalInputTokens: 90_000n,
      }),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [],
    });
    expect(thin.find((r) => r.id === 'cache-efficiency')).toBeUndefined();
  });

  it('suppresses a single permission denial — the floor, not just the sort', () => {
    // The pre-existing test for this case was bumped from 1 denial to 2 when
    // MIN_PERMISSION_DENIALS landed, which consumed the coverage rather than
    // adding to it. This is the mirror that pins the floor itself.
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: { ...NO_FRICTION, denial: 0.2 },
      toolPerf: [toolPerf({ callCount: 4, deniedCount: 1, errorCount: 0 })],
    });
    expect(recs.find((r) => r.id === 'permission-denials')).toBeUndefined();
  });

  it('gates tool errors on the Wilson lower bound, not the raw ratio', () => {
    // 1 of 5 is a raw 20% — exactly TOOL_ERROR_RATE_WARN — but its Wilson lower
    // bound is ~3.6%, far under. Under the old raw-ratio rule this WOULD be
    // flagged, so this case is what discriminates the two implementations.
    const recs = buildRecommendations({
      cacheSummary: cacheSummary(),
      mcp: [mcp({ callCount: 5, errorCount: 1, mcpServer: 'flakey' })],
      modelRouting: [],
      policies: POLICIES,
      scoredSessionCount: 8,
      sources: NO_FRICTION,
      toolPerf: [toolPerf({ callCount: 5, errorCount: 1, toolName: 'Grep' })],
    });
    expect(recs.find((r) => r.id === 'tool-errors:Grep')).toBeUndefined();
    expect(recs.find((r) => r.id === 'mcp-errors:flakey')).toBeUndefined();
  });
});
