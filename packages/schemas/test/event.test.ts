import { describe, expect, it } from 'vitest';

import {
  EVENTS_API_VERSION,
  EventSchema,
  EventsBatchSchema,
  PriceTableSchema,
  TranscriptChunkMetaSchema,
} from '../src/index';

const validEvent = {
  client: {
    claude_code_version: '1.2.3',
    hostname_hash: 'sha256:abcdef1234567890',
    os: 'darwin' as const,
  },
  event_id: '01939f6c-1234-7000-8000-0123456789ab',
  event_type: 'PostToolUse' as const,
  llm: {
    cache_creation_tokens: 0,
    cache_read_tokens: 18420,
    cost_usd: 0.00487,
    input_tokens: 142,
    model: 'claude-sonnet-4-6',
    output_tokens: 318,
  },
  metadata: {},
  schema_version: 1 as const,
  session_context: {
    cwd: '/Users/jorge/code/foo',
    git: {
      branch: 'feat/JIRA-1234',
      commit: 'abc1234',
      is_dirty: true,
      owner: 's1',
      pr_number: 4421,
      remote_url: 'git@github.com:s1/foo.git',
      repo: 'foo',
    },
    is_resume: false,
    mode: 'normal' as const,
  },
  session_id: '123e4567-e89b-12d3-a456-426614174000',
  tool: {
    category: 'fs_write',
    duration_ms: 287,
    exit_status: 0,
    input_bytes: 1842,
    input_hash: 'sha256:abc',
    mcp_server: null,
    mcp_tool: null,
    name: 'Edit',
    output_bytes: 312,
    skill: null,
    slash_command: null,
    subagent_type: null,
    was_denied: false,
    was_interrupted: false,
  },
  ts: '2026-05-16T14:32:11.482Z',
  turn_number: 17,
  user_id_claim: 'github:jorgef',
};

describe('EventSchema', () => {
  it('parses a valid event', () => {
    const result = EventSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it('applies defaults: agent_type, redaction_flags, metadata', () => {
    const result = EventSchema.parse(validEvent);
    expect(result.agent_type).toBe('CLAUDE_CODE');
    expect(result.redaction_flags).toEqual([]);
    expect(result.metadata).toEqual({});
  });

  it('rejects missing event_id', () => {
    const { event_id: _, ...noId } = validEvent;
    expect(EventSchema.safeParse(noId).success).toBe(false);
  });

  it('rejects invalid event_type', () => {
    expect(EventSchema.safeParse({ ...validEvent, event_type: 'BadEvent' }).success).toBe(false);
  });

  it('rejects invalid agent_type', () => {
    expect(EventSchema.safeParse({ ...validEvent, agent_type: 'vscode' }).success).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    expect(EventSchema.safeParse({ ...validEvent, schema_version: 2 }).success).toBe(false);
  });

  it('rejects non-ISO ts', () => {
    expect(EventSchema.safeParse({ ...validEvent, ts: 'not-a-date' }).success).toBe(false);
  });

  it('rejects invalid event_id', () => {
    expect(EventSchema.safeParse({ ...validEvent, event_id: 'not-a-uuid' }).success).toBe(false);
  });

  it('allows null tool for UserPromptSubmit', () => {
    const result = EventSchema.safeParse({
      ...validEvent,
      event_type: 'UserPromptSubmit',
      tool: null,
    });
    expect(result.success).toBe(true);
  });

  it('allows null llm for SessionStart', () => {
    const result = EventSchema.safeParse({ ...validEvent, event_type: 'SessionStart', llm: null });
    expect(result.success).toBe(true);
  });

  it('strips unknown fields in tool (z.object default behavior)', () => {
    const bad = { ...validEvent, tool: { ...validEvent.tool, unknown_field: 'x' } };
    // z.object strips unknowns by default — parse succeeds but strips the field
    const result = EventSchema.safeParse(bad);
    expect(result.success).toBe(true);
    if (result.success && result.data.tool) {
      expect('unknown_field' in result.data.tool).toBe(false);
    }
  });

  it('requires a tool block on PreToolUse and PostToolUse', () => {
    const { tool: _tool, ...noTool } = validEvent;
    expect(EventSchema.safeParse({ ...noTool, event_type: 'PostToolUse' }).success).toBe(false);
    expect(EventSchema.safeParse({ ...noTool, event_type: 'PreToolUse' }).success).toBe(false);
  });

  it('accepts a minimal tool block on PostToolUse and fills defaults', () => {
    const { tool: _tool, ...noTool } = validEvent;
    const result = EventSchema.safeParse({
      ...noTool,
      event_type: 'PostToolUse',
      tool: { name: 'Edit' },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.tool) {
      expect(result.data.tool.category).toBe('other');
      expect(result.data.tool.duration_ms).toBe(0);
      expect(result.data.tool.was_denied).toBe(false);
    }
  });

  it('does not require a tool block on lifecycle events', () => {
    const { tool: _tool, ...noTool } = validEvent;
    expect(EventSchema.safeParse({ ...noTool, event_type: 'SessionStart' }).success).toBe(true);
    expect(EventSchema.safeParse({ ...noTool, event_type: 'Stop' }).success).toBe(true);
  });
});

describe('EventsBatchSchema', () => {
  it('parses a valid batch', () => {
    const batch = { events: [validEvent], session_context: validEvent.session_context };
    expect(EventsBatchSchema.safeParse(batch).success).toBe(true);
  });

  it('rejects batch missing session_context', () => {
    expect(EventsBatchSchema.safeParse({ events: [validEvent] }).success).toBe(false);
  });

  it('accepts an empty events array', () => {
    const batch = { events: [], session_context: validEvent.session_context };
    expect(EventsBatchSchema.safeParse(batch).success).toBe(true);
  });
});

describe('TranscriptChunkMetaSchema', () => {
  const validMeta = {
    chunk_index: 0,
    session_id: '123e4567-e89b-12d3-a456-426614174000',
    sha256: 'abc123def456',
    total_chunks: 3,
  };

  it('parses valid chunk meta', () => {
    expect(TranscriptChunkMetaSchema.safeParse(validMeta).success).toBe(true);
  });

  it('rejects negative chunk_index', () => {
    expect(TranscriptChunkMetaSchema.safeParse({ ...validMeta, chunk_index: -1 }).success).toBe(
      false,
    );
  });

  it('rejects zero total_chunks', () => {
    expect(TranscriptChunkMetaSchema.safeParse({ ...validMeta, total_chunks: 0 }).success).toBe(
      false,
    );
  });
});

describe('PriceTableSchema', () => {
  const validTable = {
    generated_at: '2026-05-01T00:00:00Z',
    prices: {
      'claude-sonnet-4-6': {
        cache_read_per_mtok: 0.3,
        cache_write_per_mtok: 3.75,
        input_per_mtok: 3.0,
        output_per_mtok: 15.0,
      },
    },
    version: '2026-05-01',
  };

  it('parses a valid price table', () => {
    expect(PriceTableSchema.safeParse(validTable).success).toBe(true);
  });

  it('rejects negative prices', () => {
    const bad = {
      ...validTable,
      prices: {
        'claude-sonnet-4-6': { ...validTable.prices['claude-sonnet-4-6'], input_per_mtok: -1 },
      },
    };
    expect(PriceTableSchema.safeParse(bad).success).toBe(false);
  });
});

describe('EVENTS_API_VERSION', () => {
  it("equals '1'", () => {
    expect(EVENTS_API_VERSION).toBe('1');
  });
});
