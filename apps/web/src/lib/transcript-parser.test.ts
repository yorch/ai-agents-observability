import { describe, expect, it } from 'vitest';
import { computeStats, type ParsedLine, parseTranscriptLine } from './transcript-parser';

function parse(obj: unknown, map = new Map<string, string>()): ParsedLine {
  return parseTranscriptLine(JSON.stringify(obj), map);
}

describe('parseTranscriptLine — user lines', () => {
  it('treats string content as a user message', () => {
    const line = parse({ message: { content: 'hi', role: 'user' }, type: 'user' });
    expect(line).toMatchObject({ content: 'hi', kind: 'user-message' });
  });

  // The shape the hook's Claude importer maps to UserPromptSubmit
  // (apps/hook/src/lib/import-synth.test.ts makeUserTextArrayEntry). It used to
  // fall through to `metadata`, which Conversation view hides.
  it('treats text-only array content as a user message', () => {
    const line = parse({
      message: { content: [{ text: 'hi', type: 'text' }], role: 'user' },
      timestamp: '2026-11-03T20:19:05.000Z',
      type: 'user',
    });
    expect(line).toMatchObject({
      content: 'hi',
      kind: 'user-message',
      timestamp: '2026-11-03T20:19:05.000Z',
    });
  });

  it('joins several text blocks', () => {
    const line = parse({
      message: {
        content: [
          { text: 'Hello, can you help me?', type: 'text' },
          { text: 'Another text block', type: 'text' },
        ],
      },
      type: 'user',
    });
    expect(line).toMatchObject({
      content: 'Hello, can you help me?\n\nAnother text block',
      kind: 'user-message',
    });
  });

  it('keeps tool-results when a line has results, resolving the tool name', () => {
    const map = new Map<string, string>();
    parse(
      {
        message: { content: [{ id: 'tu1', input: {}, name: 'Read', type: 'tool_use' }] },
        type: 'assistant',
      },
      map,
    );
    const line = parse(
      {
        message: {
          content: [{ content: 'boom', is_error: true, tool_use_id: 'tu1', type: 'tool_result' }],
        },
        type: 'user',
      },
      map,
    );
    expect(line.kind).toBe('tool-results');
    if (line.kind !== 'tool-results') {
      return;
    }
    expect(line.results).toEqual([
      { content: 'boom', isError: true, tool_use_id: 'tu1', toolName: 'Read', type: 'tool_result' },
    ]);
    expect(line.note).toBeUndefined();
  });

  it('keeps the text of a mixed text + tool_result line as a note rather than dropping it', () => {
    const line = parse({
      message: {
        content: [
          { content: 'ok', tool_use_id: 'x', type: 'tool_result' },
          { text: '[Request interrupted by user]', type: 'text' },
        ],
      },
      type: 'user',
    });
    expect(line).toMatchObject({ kind: 'tool-results', note: '[Request interrupted by user]' });
  });

  it('treats isMeta user lines as metadata, not prompts', () => {
    expect(
      parse({
        isMeta: true,
        message: { content: [{ text: 'Caveat: ...', type: 'text' }] },
        type: 'user',
      }).kind,
    ).toBe('metadata');
    expect(parse({ isMeta: true, message: { content: 'injected' }, type: 'user' }).kind).toBe(
      'metadata',
    );
  });

  it('maps interrupt markers to the muted note shape, not a prompt', () => {
    for (const text of [
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
    ]) {
      expect(parse({ message: { content: [{ text, type: 'text' }] }, type: 'user' })).toMatchObject(
        {
          kind: 'tool-results',
          note: text,
          results: [],
        },
      );
      expect(parse({ message: { content: text }, type: 'user' }).kind).toBe('tool-results');
    }
    expect(
      parse({
        message: { content: [{ text: 'interrupted by user, please redo', type: 'text' }] },
        type: 'user',
      }).kind,
    ).toBe('user-message');
  });

  it('leaves an array with no text and no results as metadata', () => {
    expect(parse({ message: { content: [] }, type: 'user' }).kind).toBe('metadata');
    expect(
      parse({ message: { content: [{ text: '   ', type: 'text' }, null] }, type: 'user' }).kind,
    ).toBe('metadata');
  });

  it('returns metadata for unparseable lines', () => {
    expect(parseTranscriptLine('{nope', new Map())).toMatchObject({
      kind: 'metadata',
      lineType: 'unparseable',
    });
  });
});

describe('computeStats', () => {
  it('counts array-content prompts as user turns', () => {
    const map = new Map<string, string>();
    const lines = [
      { message: { content: 'first' }, type: 'user' },
      {
        message: {
          content: [
            { text: 'ok', type: 'text' },
            { id: 't', input: {}, name: 'Bash', type: 'tool_use' },
          ],
          model: 'm',
          usage: { input_tokens: 1, output_tokens: 7 },
        },
        type: 'assistant',
      },
      {
        message: { content: [{ content: 'r', tool_use_id: 't', type: 'tool_result' }] },
        type: 'user',
      },
      { message: { content: [{ text: 'second', type: 'text' }] }, type: 'user' },
      { summary: 's', type: 'summary' },
    ].map((o) => parse(o, map));
    const stats = computeStats(lines);
    expect(stats.userTurns).toBe(2);
    expect(stats.assistantTurns).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.outputTokens).toBe(7);
    expect(stats.models).toEqual(['m']);
  });
});
