import { describe, expect, it } from 'vitest';
import { labelToolRows } from '../src/lib/tool-usage.js';

describe('labelToolRows', () => {
  it('leaves tool names raw for a single-agent result set', () => {
    const rows = [
      { agent_type: 'CLAUDE_CODE', call_count: 10n, tool_name: 'Edit' },
      { agent_type: 'CLAUDE_CODE', call_count: 4n, tool_name: 'Bash' },
    ];
    expect(labelToolRows(rows)).toEqual([
      { callCount: 10, toolName: 'Edit' },
      { callCount: 4, toolName: 'Bash' },
    ]);
  });

  it('prefixes the agent when the result set spans multiple agents', () => {
    const rows = [
      { agent_type: 'CLAUDE_CODE', call_count: 10n, tool_name: 'Edit' },
      { agent_type: 'OPENCODE', call_count: 6n, tool_name: 'Edit' },
    ];
    expect(labelToolRows(rows)).toEqual([
      { callCount: 10, toolName: 'CLAUDE_CODE:Edit' },
      { callCount: 6, toolName: 'OPENCODE:Edit' },
    ]);
  });

  it('keeps same-named tools from different agents as distinct rows', () => {
    const rows = [
      { agent_type: 'CLAUDE_CODE', call_count: 3n, tool_name: 'Edit' },
      { agent_type: 'OPENCODE', call_count: 2n, tool_name: 'Edit' },
    ];
    const labels = labelToolRows(rows).map((r) => r.toolName);
    expect(new Set(labels).size).toBe(2);
  });

  it('handles an empty result set', () => {
    expect(labelToolRows([])).toEqual([]);
  });
});
