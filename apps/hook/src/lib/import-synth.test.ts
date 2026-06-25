import { describe, expect, it } from 'bun:test';

import { type Event, EventSchema } from '@ai-agents-observability/schemas';

import { createSynthCtx, entryToEvents, type SynthCtx } from './import-synth';
import type { ClaudeEntry } from './transcript-parser';
import { deterministicEventId } from './uuid5';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = '01906a44-0000-7000-8000-000000000001';
const CWD = '/home/user/project';
const TS = '2026-06-25T10:00:00.000Z';
const ENTRY_UUID = '01906a44-0000-7000-8000-aabbccddeeff';
const TOOL_USE_ID = 'toolu_01XYZabc123456';

function makeCtx(overrides?: Partial<SynthCtx>): SynthCtx {
  const ctx = createSynthCtx(SESSION_ID, CWD, '1.2.3');
  if (overrides) {
    Object.assign(ctx, overrides);
  }
  return ctx;
}

function makeSummaryEntry(): ClaudeEntry {
  return {
    sessionId: SESSION_ID,
    summary: 'This is a session summary',
    timestamp: TS,
    type: 'summary',
    uuid: ENTRY_UUID,
  };
}

function makeUserStringEntry(): ClaudeEntry {
  return {
    message: {
      content: 'Hello, can you help me?',
      role: 'user',
    },
    sessionId: SESSION_ID,
    timestamp: TS,
    type: 'user',
    uuid: ENTRY_UUID,
  };
}

function makeUserTextArrayEntry(): ClaudeEntry {
  return {
    message: {
      content: [
        { text: 'Hello, can you help me?', type: 'text' },
        { text: 'Another text block', type: 'text' },
      ],
      role: 'user',
    },
    sessionId: SESSION_ID,
    timestamp: TS,
    type: 'user',
    uuid: ENTRY_UUID,
  };
}

function makeUserToolResultEntry(): ClaudeEntry {
  return {
    message: {
      content: [
        {
          content: 'file contents here',
          tool_use_id: TOOL_USE_ID,
          type: 'tool_result',
        },
      ],
      role: 'user',
    },
    sessionId: SESSION_ID,
    timestamp: TS,
    type: 'user',
    uuid: ENTRY_UUID,
  };
}

function makeUserMultipleToolResultEntry(): ClaudeEntry {
  return {
    message: {
      content: [
        {
          content: 'output 1',
          tool_use_id: 'tool-id-1',
          type: 'tool_result',
        },
        {
          content: 'output 2',
          tool_use_id: 'tool-id-2',
          type: 'tool_result',
        },
      ],
      role: 'user',
    },
    sessionId: SESSION_ID,
    timestamp: TS,
    type: 'user',
    uuid: ENTRY_UUID,
  };
}

function makeAssistantEntry(): ClaudeEntry {
  return {
    message: {
      content: [
        { text: 'I will help you with that.', type: 'text' },
        {
          id: 'toolu_001',
          input: { file_path: '/home/user/file.txt' },
          name: 'Read',
          type: 'tool_use',
        },
        {
          id: 'toolu_002',
          input: { command: 'ls -la' },
          name: 'Bash',
          type: 'tool_use',
        },
      ],
      id: 'msg_01',
      model: 'claude-opus-4-5',
      role: 'assistant',
      stop_reason: 'tool_use',
      usage: {
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 500,
        input_tokens: 1000,
        output_tokens: 200,
      },
    },
    sessionId: SESSION_ID,
    timestamp: TS,
    type: 'assistant',
    uuid: ENTRY_UUID,
  };
}

function makeAssistantNoUsageEntry(): ClaudeEntry {
  return {
    message: {
      content: [{ text: 'Done.', type: 'text' }],
      id: 'msg_02',
      model: 'claude-opus-4-5',
      role: 'assistant',
      stop_reason: 'end_turn',
    },
    sessionId: SESSION_ID,
    timestamp: TS,
    type: 'assistant',
    uuid: ENTRY_UUID,
  };
}

function makeMcpToolEntry(): ClaudeEntry {
  return {
    message: {
      content: [
        {
          id: 'toolu_mcp',
          input: { query: 'search term' },
          name: 'mcp__Server__toolName',
          type: 'tool_use',
        },
      ],
      id: 'msg_03',
      model: 'claude-opus-4-5',
      role: 'assistant',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
    sessionId: SESSION_ID,
    timestamp: TS,
    type: 'assistant',
    uuid: ENTRY_UUID,
  };
}

function makeTaskToolEntry(): ClaudeEntry {
  return {
    message: {
      content: [
        {
          id: 'toolu_task',
          input: { description: 'Do a task', subagent_type: 'claude-code-guide' },
          name: 'Task',
          type: 'tool_use',
        },
      ],
      id: 'msg_04',
      model: 'claude-opus-4-5',
      role: 'assistant',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 200,
        output_tokens: 80,
      },
    },
    sessionId: SESSION_ID,
    timestamp: TS,
    type: 'assistant',
    uuid: ENTRY_UUID,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('entryToEvents — summary', () => {
  it('returns empty array for summary entries', () => {
    const ctx = makeCtx();
    expect(entryToEvents(makeSummaryEntry(), ctx)).toEqual([]);
  });
});

describe('entryToEvents — user (string content)', () => {
  it('emits exactly 1 UserPromptSubmit', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeUserStringEntry(), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('UserPromptSubmit');
  });

  it('event has correct session_id and ts', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeUserStringEntry(), ctx);
    expect(events[0]?.session_id).toBe(SESSION_ID);
    expect(events[0]?.ts).toBe(TS);
  });

  it('event_id is deterministic', () => {
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    const events1 = entryToEvents(makeUserStringEntry(), ctx1);
    const events2 = entryToEvents(makeUserStringEntry(), ctx2);
    expect((events1[0] as Event).event_id).toBe((events2[0] as Event).event_id);
  });

  it('event_id matches deterministicEventId output', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeUserStringEntry(), ctx);
    expect(events[0]?.event_id).toBe(deterministicEventId(`${ENTRY_UUID}:user`));
  });

  it('metadata includes imported flag', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeUserStringEntry(), ctx);
    expect((events[0]?.metadata as Record<string, unknown>)?.imported).toBe(true);
  });

  it('passes EventSchema.safeParse', () => {
    const ctx = makeCtx();
    for (const event of entryToEvents(makeUserStringEntry(), ctx)) {
      const result = EventSchema.safeParse(event);
      if (!result.success) {
        console.error('Validation error:', JSON.stringify(result.error, null, 2));
      }
      expect(result.success).toBe(true);
    }
  });
});

describe('entryToEvents — user (text array content)', () => {
  it('emits exactly 1 UserPromptSubmit for text-only array', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeUserTextArrayEntry(), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('UserPromptSubmit');
  });

  it('passes EventSchema.safeParse', () => {
    const ctx = makeCtx();
    for (const event of entryToEvents(makeUserTextArrayEntry(), ctx)) {
      const result = EventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });
});

describe('entryToEvents — user (tool_result content)', () => {
  it('emits 1 PostToolUse per tool_result block', () => {
    const ctx = makeCtx();
    ctx.toolNameMap.set(TOOL_USE_ID, 'Read');
    const events = entryToEvents(makeUserToolResultEntry(), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('PostToolUse');
  });

  it('tool name comes from ctx.toolNameMap', () => {
    const ctx = makeCtx();
    ctx.toolNameMap.set(TOOL_USE_ID, 'Read');
    const events = entryToEvents(makeUserToolResultEntry(), ctx);
    expect(events[0]?.tool?.name).toBe('Read');
  });

  it("falls back to 'unknown' when tool_use_id not in map", () => {
    const ctx = makeCtx();
    // toolNameMap not populated
    const events = entryToEvents(makeUserToolResultEntry(), ctx);
    expect(events[0]?.tool?.name).toBe('unknown');
  });

  it('emits multiple PostToolUse events for multiple tool_result blocks', () => {
    const ctx = makeCtx();
    ctx.toolNameMap.set('tool-id-1', 'Read');
    ctx.toolNameMap.set('tool-id-2', 'Write');
    const events = entryToEvents(makeUserMultipleToolResultEntry(), ctx);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.event_type === 'PostToolUse')).toBe(true);
    expect(events[0]?.tool?.name).toBe('Read');
    expect(events[1]?.tool?.name).toBe('Write');
  });

  it('event_id is deterministic based on tool_use_id', () => {
    const ctx1 = makeCtx();
    ctx1.toolNameMap.set(TOOL_USE_ID, 'Read');
    const ctx2 = makeCtx();
    ctx2.toolNameMap.set(TOOL_USE_ID, 'Read');
    const e1 = entryToEvents(makeUserToolResultEntry(), ctx1);
    const e2 = entryToEvents(makeUserToolResultEntry(), ctx2);
    expect((e1[0] as Event).event_id).toBe((e2[0] as Event).event_id);
  });

  it('passes EventSchema.safeParse', () => {
    const ctx = makeCtx();
    ctx.toolNameMap.set(TOOL_USE_ID, 'Read');
    for (const event of entryToEvents(makeUserToolResultEntry(), ctx)) {
      const result = EventSchema.safeParse(event);
      if (!result.success) {
        console.error('Validation error:', JSON.stringify(result.error, null, 2));
      }
      expect(result.success).toBe(true);
    }
  });
});

describe('entryToEvents — assistant (with usage + tool_use blocks)', () => {
  it('emits Stop + PreToolUse per tool_use block (3 total for 2 tools)', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeAssistantEntry(), ctx);
    expect(events).toHaveLength(3);
  });

  it('first event is Stop', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeAssistantEntry(), ctx);
    expect(events[0]?.event_type).toBe('Stop');
  });

  it('Stop event has llm block with correct token counts', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeAssistantEntry(), ctx);
    const stop = events.find((e) => e.event_type === 'Stop');
    expect(stop?.llm?.input_tokens).toBe(1000);
    expect(stop?.llm?.output_tokens).toBe(200);
    expect(stop?.llm?.cache_read_tokens).toBe(500);
    expect(stop?.llm?.cache_creation_tokens).toBe(100);
    expect(stop?.llm?.cost_usd).toBe(0);
    expect(stop?.llm?.model).toBe('claude-opus-4-5');
  });

  it('remaining events are PreToolUse with correct tool names', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeAssistantEntry(), ctx);
    const preTools = events.filter((e) => e.event_type === 'PreToolUse');
    expect(preTools).toHaveLength(2);
    expect(preTools[0]?.tool?.name).toBe('Read');
    expect(preTools[1]?.tool?.name).toBe('Bash');
  });

  it('populates toolNameMap for later PostToolUse lookup', () => {
    const ctx = makeCtx();
    entryToEvents(makeAssistantEntry(), ctx);
    expect(ctx.toolNameMap.get('toolu_001')).toBe('Read');
    expect(ctx.toolNameMap.get('toolu_002')).toBe('Bash');
  });

  it('all events pass EventSchema.safeParse', () => {
    const ctx = makeCtx();
    for (const event of entryToEvents(makeAssistantEntry(), ctx)) {
      const result = EventSchema.safeParse(event);
      if (!result.success) {
        console.error(
          `Validation error for ${event.event_type}:`,
          JSON.stringify(result.error, null, 2),
        );
      }
      expect(result.success).toBe(true);
    }
  });
});

describe('entryToEvents — assistant (no usage)', () => {
  it('still emits a Stop event', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeAssistantNoUsageEntry(), ctx);
    const stops = events.filter((e) => e.event_type === 'Stop');
    expect(stops).toHaveLength(1);
  });

  it('Stop event has no llm block when no usage', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeAssistantNoUsageEntry(), ctx);
    const stop = events.find((e) => e.event_type === 'Stop');
    expect(stop?.llm).toBeUndefined();
  });

  it('passes EventSchema.safeParse', () => {
    const ctx = makeCtx();
    for (const event of entryToEvents(makeAssistantNoUsageEntry(), ctx)) {
      const result = EventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });
});

describe('entryToEvents — MCP tool', () => {
  it("sets category to 'mcp'", () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeMcpToolEntry(), ctx);
    const preTools = events.filter((e) => e.event_type === 'PreToolUse');
    expect(preTools[0]?.tool?.category).toBe('mcp');
  });

  it('splits mcp__Server__toolName correctly', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeMcpToolEntry(), ctx);
    const preTools = events.filter((e) => e.event_type === 'PreToolUse');
    expect(preTools[0]?.tool?.mcp_server).toBe('Server');
    expect(preTools[0]?.tool?.mcp_tool).toBe('toolName');
  });

  it('passes EventSchema.safeParse', () => {
    const ctx = makeCtx();
    for (const event of entryToEvents(makeMcpToolEntry(), ctx)) {
      const result = EventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });
});

describe('entryToEvents — Task tool with subagent_type', () => {
  it('sets tool.subagent_type from input.subagent_type', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeTaskToolEntry(), ctx);
    const preTools = events.filter((e) => e.event_type === 'PreToolUse');
    expect(preTools[0]?.tool?.subagent_type).toBe('claude-code-guide');
  });

  it('passes EventSchema.safeParse', () => {
    const ctx = makeCtx();
    for (const event of entryToEvents(makeTaskToolEntry(), ctx)) {
      const result = EventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });
});

describe('entryToEvents — idempotency', () => {
  it('re-running on the same entry produces identical event_ids', () => {
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    const events1 = entryToEvents(makeAssistantEntry(), ctx1);
    const events2 = entryToEvents(makeAssistantEntry(), ctx2);
    expect(events1.map((e) => e.event_id)).toEqual(events2.map((e) => e.event_id));
  });
});

describe('entryToEvents — unknown type', () => {
  it('returns empty array for unknown entry types', () => {
    const ctx = makeCtx();
    const entry: ClaudeEntry = {
      timestamp: TS,
      type: 'unknown_future_type',
      uuid: ENTRY_UUID,
    };
    expect(entryToEvents(entry, ctx)).toEqual([]);
  });
});

describe('entryToEvents — metadata and version', () => {
  it('includes claude_code_version_import when version is set', () => {
    const ctx = makeCtx();
    const events = entryToEvents(makeUserStringEntry(), ctx);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect(meta?.claude_code_version_import).toBe('1.2.3');
    expect(meta?.source).toBe('claude-jsonl');
  });

  it('omits claude_code_version_import when version is null', () => {
    const ctx = createSynthCtx(SESSION_ID, CWD, null);
    const events = entryToEvents(makeUserStringEntry(), ctx);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect('claude_code_version_import' in meta).toBe(false);
  });
});
