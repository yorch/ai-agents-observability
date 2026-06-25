import { describe, expect, it } from 'bun:test';

import { type CodexUsage, parseRolloutRecords, usageDelta } from './codex-rollout';

describe('parseRolloutRecords', () => {
  it('pairs a flat function_call with its output and counts bytes', () => {
    const { toolCalls } = parseRolloutRecords([
      { arguments: '{"command":"ls -la"}', call_id: 'c1', name: 'shell', type: 'function_call' },
      { call_id: 'c1', output: 'file-a\nfile-b\n', type: 'function_call_output' },
    ]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('shell');
    expect(toolCalls[0]?.inputBytes).toBeGreaterThan(0);
    expect(toolCalls[0]?.outputBytes).toBeGreaterThan(0);
    expect(toolCalls[0]?.wasDenied).toBe(false);
  });

  it('unwraps the newer { type, payload } envelope', () => {
    const { toolCalls } = parseRolloutRecords([
      {
        payload: { arguments: '{}', call_id: 'x', name: 'apply_patch', type: 'function_call' },
        type: 'response_item',
      },
    ]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('apply_patch');
  });

  it('flags a denied tool call from its output text', () => {
    const { toolCalls } = parseRolloutRecords([
      { arguments: '{}', call_id: 'c9', name: 'shell', type: 'function_call' },
      { call_id: 'c9', output: 'command rejected by user', type: 'function_call_output' },
    ]);
    expect(toolCalls[0]?.wasDenied).toBe(true);
  });

  it('reads cumulative usage + model from a token_count event (info.total_token_usage)', () => {
    const { cumulativeUsage } = parseRolloutRecords([
      { model: 'gpt-5-codex', type: 'turn_context' },
      {
        info: {
          total_token_usage: { cached_input_tokens: 100, input_tokens: 1200, output_tokens: 300 },
        },
        type: 'token_count',
      },
    ]);
    expect(cumulativeUsage?.model).toBe('gpt-5-codex');
    expect(cumulativeUsage?.inputTokens).toBe(1200);
    expect(cumulativeUsage?.outputTokens).toBe(300);
    expect(cumulativeUsage?.cacheReadTokens).toBe(100);
  });

  it('reads a flat usage shape', () => {
    const { cumulativeUsage } = parseRolloutRecords([
      { input_tokens: 50, output_tokens: 10, type: 'token_count' },
    ]);
    expect(cumulativeUsage?.inputTokens).toBe(50);
    expect(cumulativeUsage?.outputTokens).toBe(10);
  });

  it('skips unrecognized records without throwing', () => {
    const { toolCalls, cumulativeUsage } = parseRolloutRecords([
      'not-an-object',
      null,
      { payload: { content: 'hi', role: 'assistant' }, type: 'message' },
      42,
    ]);
    expect(toolCalls).toHaveLength(0);
    expect(cumulativeUsage).toBeNull();
  });
});

describe('usageDelta', () => {
  const u = (input: number, output: number): CodexUsage => ({
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: input,
    model: 'gpt-5-codex',
    outputTokens: output,
  });

  it('returns the full current usage when there is no prior cursor', () => {
    expect(usageDelta(null, u(100, 20))).toEqual(u(100, 20));
  });

  it('subtracts the prior cumulative total (token_count is a running total)', () => {
    const delta = usageDelta(u(100, 20), u(180, 50));
    expect(delta?.inputTokens).toBe(80);
    expect(delta?.outputTokens).toBe(30);
  });

  it('clamps to zero if the counter reset (new session reusing the cursor)', () => {
    const delta = usageDelta(u(500, 200), u(40, 10));
    expect(delta?.inputTokens).toBe(0);
    expect(delta?.outputTokens).toBe(0);
  });

  it('returns null when there is no current usage', () => {
    expect(usageDelta(u(1, 1), null)).toBeNull();
  });
});
