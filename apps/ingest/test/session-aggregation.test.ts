import type { Prisma } from '@ai-agents-observability/db';
import type { Event, PriceTable } from '@ai-agents-observability/schemas';
import { describe, expect, it, vi } from 'vitest';

import { upsertSessions } from '../src/lib/upsert-session';

const PRICE_TABLE: PriceTable = {
  generated_at: '2026-05-01T00:00:00+00:00',
  prices: {
    'claude-sonnet-4-6': {
      cache_read_per_mtok: 0.3,
      cache_write_per_mtok: 3.75,
      input_per_mtok: 3,
      output_per_mtok: 15,
    },
  },
  version: '1',
};

// Registry stub that prices every agent against this test's table.
const PRICE_TABLES = {
  forAgentParam: () => PRICE_TABLE,
  resolve: () => PRICE_TABLE,
};

const BASE_CLIENT = {
  claude_code_version: '1.0.0',
  hostname_hash: 'sha256:abc',
  os: 'linux' as const,
};

const BASE_CTX = {
  cwd: '/home/dev/proj',
  git: null,
  is_resume: false,
  mode: 'normal' as const,
};

function makeEvent(overrides: Partial<Event> & Pick<Event, 'event_id' | 'event_type'>): Event {
  return {
    agent_type: 'CLAUDE_CODE',
    client: BASE_CLIENT,
    metadata: {},
    redaction_flags: [],
    schema_version: 1,
    session_context: BASE_CTX,
    session_id: '01906a44-0000-7000-8000-000000000000',
    ts: '2026-05-21T12:00:00Z',
    user_id_claim: '00000000-0000-0000-0000-000000000001',
    ...overrides,
  };
}

type CapturedSql = { params: unknown[]; sql: string };

function makeDb(): {
  $executeRaw: ReturnType<typeof vi.fn>;
  captured: CapturedSql[];
} {
  const captured: CapturedSql[] = [];
  const fn = vi.fn(async (query: Prisma.Sql) => {
    captured.push({ params: [...query.values], sql: query.sql });
    return captured[captured.length - 1]?.params.length ?? 0;
  });
  return { $executeRaw: fn, captured };
}

describe('upsertSessions', () => {
  it('returns 0 for an empty batch and does not query', async () => {
    const db = makeDb();
    const result = await upsertSessions(db, [], 'u1', new Map(), PRICE_TABLES);
    expect(result.sessionsTouched).toBe(0);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('groups events by session_id into one upsert row per session', async () => {
    const db = makeDb();
    const events = [
      makeEvent({ event_id: '01906a44-0000-7000-8000-000000000001', event_type: 'SessionStart' }),
      makeEvent({
        event_id: '01906a44-0000-7000-8000-000000000002',
        event_type: 'UserPromptSubmit',
      }),
      makeEvent({
        event_id: '01906a44-0000-7000-8000-000000000003',
        event_type: 'PostToolUse',
        tool: {
          category: 'read',
          duration_ms: 5,
          exit_status: 0,
          input_bytes: 100,
          input_hash: null,
          mcp_server: null,
          mcp_tool: null,
          name: 'Read',
          output_bytes: 50,
          skill: null,
          slash_command: null,
          subagent_type: null,
          was_denied: false,
          was_interrupted: false,
        },
      }),
      makeEvent({
        event_id: '01906a44-0000-7000-8000-000000000004',
        event_type: 'PostToolUse',
        session_id: '01906a44-0000-7000-8000-aaaaaaaaaaaa',
        tool: {
          category: 'exec',
          duration_ms: 12,
          exit_status: 1,
          input_bytes: 30,
          input_hash: null,
          mcp_server: null,
          mcp_tool: null,
          name: 'Bash',
          output_bytes: 80,
          skill: null,
          slash_command: null,
          subagent_type: null,
          was_denied: false,
          was_interrupted: false,
        },
      }),
    ];

    const result = await upsertSessions(db, events, 'u1', new Map(), PRICE_TABLES);
    expect(result.sessionsTouched).toBeGreaterThan(0);

    const call = db.captured[0];
    expect(call).toBeDefined();
    expect(call?.sql).toContain('INSERT INTO sessions');
    expect(call?.sql).toContain('ON CONFLICT (session_id)');
    expect(call?.sql).toContain(
      'tool_call_count      = sessions.tool_call_count + EXCLUDED.tool_call_count',
    );
  });

  it('marks the session ended when a Stop event is present', async () => {
    const db = makeDb();
    const events = [
      makeEvent({ event_id: '01906a44-0000-7000-8000-000000000001', event_type: 'SessionStart' }),
      makeEvent({
        event_id: '01906a44-0000-7000-8000-000000000002',
        event_type: 'Stop',
        ts: '2026-05-21T12:30:00Z',
      }),
    ];

    await upsertSessions(db, events, 'u1', new Map(), PRICE_TABLES);

    const call = db.captured[0];
    expect(call).toBeDefined();
    // The endedAt parameter for this session should be the Stop event's ts.
    const stopTimestamp = '2026-05-21T12:30:00.000Z';
    const endedAtPresent = call?.params.some(
      (p) => p instanceof Date && p.toISOString() === stopTimestamp,
    );
    expect(endedAtPresent).toBe(true);
    // The status literal 'COMPLETED' appears in the row VALUES.
    expect(call?.params).toContain('COMPLETED');
  });

  it('accumulates llm token totals into the per-session row', async () => {
    const db = makeDb();
    const llm = {
      cache_creation_tokens: 0,
      cache_read_tokens: 100,
      cost_usd: 0,
      input_tokens: 200,
      model: 'claude-sonnet-4-6',
      output_tokens: 80,
    };
    const events = [
      makeEvent({ event_id: '01906a44-0000-7000-8000-000000000001', event_type: 'Stop', llm }),
      makeEvent({ event_id: '01906a44-0000-7000-8000-000000000002', event_type: 'Stop', llm }),
    ];

    await upsertSessions(db, events, 'u1', new Map(), PRICE_TABLES);

    const call = db.captured[0];
    // Sums are 400 / 160 / 200 — confirm at least the input total is present.
    expect(call?.params).toContain(400);
    expect(call?.params).toContain(160);
    expect(call?.params).toContain(200);
  });

  it('resolves repo_id for events whose session_context carries a git remote', async () => {
    const db = makeDb();
    const event = makeEvent({
      event_id: '01906a44-0000-7000-8000-000000000001',
      event_type: 'SessionStart',
      session_context: {
        cwd: '/home/dev/proj',
        git: {
          branch: 'main',
          commit: 'abc',
          is_dirty: false,
          owner: 'acme',
          pr_number: null,
          remote_url: 'git@github.com:acme/proj.git',
          repo: 'proj',
        },
        is_resume: false,
        mode: 'normal',
      },
    });
    const repoIds = new Map<string, string>([['acme/proj', 'r1']]);

    await upsertSessions(db, [event], 'u1', repoIds, PRICE_TABLES);
    expect(db.captured[0]?.params).toContain('r1');
  });

  it('wires the HITL aggregates (mode, notification_count, permission_prompt_count) into the upsert', async () => {
    const db = makeDb();
    const events = [
      makeEvent({
        event_id: '01906a44-0000-7000-8000-000000000001',
        event_type: 'Notification',
        metadata: { notification_kind: 'permission' },
      }),
      makeEvent({
        event_id: '01906a44-0000-7000-8000-000000000002',
        event_type: 'Notification',
        metadata: { notification_kind: 'idle' },
      }),
    ];

    await upsertSessions(db, events, 'u1', new Map(), PRICE_TABLES);
    const call = db.captured[0];
    expect(call?.sql).toContain('project_name, mode,');
    expect(call?.sql).toContain('user_message_count, notification_count, primary_model');
    expect(call?.sql).toContain(
      'permission_prompt_count = sessions.permission_prompt_count + EXCLUDED.permission_prompt_count',
    );
    expect(call?.sql).toContain(
      'notification_count   = sessions.notification_count + EXCLUDED.notification_count',
    );
    // Representative mode is chosen by the autonomy-rank CASE on conflict.
    expect(call?.sql).toContain('WHEN EXCLUDED.mode IS NULL THEN sessions.mode');
  });

  it('records the least-supervised mode observed across the batch', async () => {
    const db = makeDb();
    const events = [
      makeEvent({
        event_id: '01906a44-0000-7000-8000-000000000001',
        event_type: 'SessionStart',
        session_context: { ...BASE_CTX, mode: 'plan' },
      }),
      makeEvent({
        event_id: '01906a44-0000-7000-8000-000000000002',
        event_type: 'PostToolUse',
        session_context: { ...BASE_CTX, mode: 'bypass' },
        tool: {
          category: 'exec',
          duration_ms: 1,
          exit_status: 0,
          input_bytes: 1,
          input_hash: null,
          mcp_server: null,
          mcp_tool: null,
          name: 'Bash',
          output_bytes: 1,
          skill: null,
          slash_command: null,
          subagent_type: null,
          was_denied: false,
          was_interrupted: false,
        },
      }),
    ];

    await upsertSessions(db, events, 'u1', new Map(), PRICE_TABLES);
    // 'bypass' (rank 5) outranks 'plan' (rank 0) → representative mode is bypass.
    // It appears among the row VALUES params (the rank-CASE literals are emitted
    // separately as their own bind params, but 'bypass' as the chosen value is
    // what the row carries).
    expect(db.captured[0]?.params).toContain('bypass');
  });

  it('falls back to batch envelope git when per-event git is null', async () => {
    const db = makeDb();
    const event = makeEvent({
      event_id: '01906a44-0000-7000-8000-000000000001',
      event_type: 'SessionStart',
      // per-event git is null — early SessionStart often captures before cwd resolves
      session_context: { cwd: '/home/dev/proj', git: null, is_resume: false, mode: 'normal' },
    });
    const envelopeGit = {
      branch: 'main',
      commit: 'abc',
      is_dirty: false,
      owner: 'acme',
      pr_number: null,
      remote_url: 'git@github.com:acme/proj.git',
      repo: 'proj',
    };
    const repoIds = new Map<string, string>([['acme/proj', 'r2']]);

    await upsertSessions(db, [event], 'u1', repoIds, PRICE_TABLES, envelopeGit);
    expect(db.captured[0]?.params).toContain('r2');
    expect(db.captured[0]?.params).toContain('main');
  });
});
