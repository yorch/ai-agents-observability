import { describe, expect, it } from 'vitest';
import { diffToolMix, metricDelta } from '../src/lib/session-compare-queries';
import type { SessionToolRow } from '../src/lib/sessions-queries';

describe('metricDelta', () => {
  it('computes right - left', () => {
    expect(metricDelta(10, 15)).toEqual({ delta: 5, left: 10, right: 15 });
    expect(metricDelta(20, 10)).toEqual({ delta: -10, left: 20, right: 10 });
  });

  it('returns null delta when either side is null', () => {
    expect(metricDelta(null, 10)).toEqual({ delta: null, left: null, right: 10 });
    expect(metricDelta(10, null)).toEqual({ delta: null, left: 10, right: null });
  });

  it('returns zero delta when both sides are equal', () => {
    expect(metricDelta(5, 5)).toEqual({ delta: 0, left: 5, right: 5 });
  });
});

describe('diffToolMix', () => {
  function tool(name: string, calls: number, errors: number, category?: string): SessionToolRow {
    return {
      avgDurationMs: null,
      callCount: calls,
      deniedCount: 0,
      errorCount: errors,
      toolCategory: category ?? null,
      toolName: name,
    };
  }

  it('joins tools by name and fills missing with zero', () => {
    const left = [tool('Read', 10, 0, 'fs_read'), tool('Write', 5, 1, 'fs_write')];
    const right = [tool('Read', 15, 2, 'fs_read'), tool('Bash', 3, 0, 'exec')];
    const diff = diffToolMix(left, right);

    const readRow = diff.find((r) => r.toolName === 'Read');
    expect(readRow).toEqual({
      leftCalls: 10,
      leftErrors: 0,
      rightCalls: 15,
      rightErrors: 2,
      toolCategory: 'fs_read',
      toolName: 'Read',
    });

    const writeRow = diff.find((r) => r.toolName === 'Write');
    expect(writeRow?.rightCalls).toBe(0);
    expect(writeRow?.rightErrors).toBe(0);

    const bashRow = diff.find((r) => r.toolName === 'Bash');
    expect(bashRow?.leftCalls).toBe(0);
  });

  it('sorts by total call count descending', () => {
    const left = [tool('Rare', 1, 0), tool('Common', 50, 0)];
    const right = [tool('Common', 30, 0), tool('Rare', 2, 0)];
    const diff = diffToolMix(left, right);
    expect(diff[0]?.toolName).toBe('Common');
    expect(diff[1]?.toolName).toBe('Rare');
  });

  it('handles empty inputs', () => {
    expect(diffToolMix([], [])).toEqual([]);
  });

  it('uses left category when right is missing, and vice versa', () => {
    const left = [tool('Read', 10, 0, 'fs_read')];
    const right = [tool('Read', 10, 0, 'search')];
    // Both present — left takes precedence (it's iterated first)
    const diff = diffToolMix(left, right);
    expect(diff[0]?.toolCategory).toBe('fs_read');
  });

  it('aggregates duplicate tool names with different categories', () => {
    // getSessionToolBreakdown groups by (tool_name, tool_category), so the same
    // tool can appear multiple times. diffToolMix must sum the counts.
    const left = [tool('Read', 10, 0, 'fs_read'), tool('Read', 5, 1, 'search')];
    const right = [tool('Read', 8, 0, 'fs_read')];
    const diff = diffToolMix(left, right);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.leftCalls).toBe(15); // 10 + 5
    expect(diff[0]?.leftErrors).toBe(1); // 0 + 1
    expect(diff[0]?.rightCalls).toBe(8);
  });
});
