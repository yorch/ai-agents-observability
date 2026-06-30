import { describe, expect, it } from 'vitest';

import type { FrictionSources } from '../src/lib/effectiveness-queries.ts';
import type { McpUsageRow, ToolPerfRow } from '../src/lib/insights-queries.ts';
import { buildRecommendations } from '../src/lib/recommendations.ts';

const NO_FRICTION: FrictionSources = { abandonment: 0, denial: 0, error: 0, interrupt: 0 };

function toolPerf(overrides: Partial<ToolPerfRow> = {}): ToolPerfRow {
  return {
    avgDurationMs: 100,
    callCount: 10,
    deniedCount: 0,
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

describe('buildRecommendations', () => {
  it('returns nothing when there are no scored sessions', () => {
    const recs = buildRecommendations({
      mcp: [mcp({ errorCount: 9 })],
      scoredSessionCount: 0,
      sources: { ...NO_FRICTION, error: 0.2 },
      toolPerf: [toolPerf({ deniedCount: 5 })],
    });
    expect(recs).toEqual([]);
  });

  it('flags frequently denied tools and marks it warn when denial dominates', () => {
    const recs = buildRecommendations({
      mcp: [],
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
      mcp: [],
      scoredSessionCount: 8,
      sources: { ...NO_FRICTION, denial: 0.02, error: 0.25 },
      toolPerf: [toolPerf({ callCount: 4, deniedCount: 1, errorCount: 0 })],
    });
    expect(recs.find((r) => r.id === 'permission-denials')?.severity).toBe('info');
  });

  it('flags error-prone tools only above the call-count and rate thresholds', () => {
    const recs = buildRecommendations({
      mcp: [],
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
      mcp: [
        mcp({ callCount: 6, errorCount: 3, mcpServer: 'github', mcpTool: 'create_pr' }),
        mcp({ callCount: 4, errorCount: 2, mcpServer: 'github', mcpTool: 'list_prs' }),
      ],
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
      mcp: [],
      scoredSessionCount: 8,
      sources: { ...NO_FRICTION, error: 0.05, interrupt: 0.12 },
      toolPerf: [],
    });
    expect(recs.find((r) => r.id === 'interrupts')).toBeDefined();
  });

  it('orders warnings before info recommendations', () => {
    const recs = buildRecommendations({
      mcp: [],
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
});
