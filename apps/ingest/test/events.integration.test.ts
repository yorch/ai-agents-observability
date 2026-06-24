import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { makeTestDeps } from './helpers';

const BATCH_FIXTURE = {
  events: [
    {
      agent_type: 'CLAUDE_CODE',
      client: { claude_code_version: '1.0.0', hostname_hash: 'abc123', os: 'linux' },
      event_id: '01906a44-0000-7000-8000-000000000001',
      event_type: 'SessionStart',
      metadata: {},
      redaction_flags: [],
      schema_version: 1,
      session_context: { cwd: '/home/user/project', git: null, is_resume: false, mode: 'normal' },
      session_id: '01906a44-0000-7000-8000-000000000000',
      ts: '2025-05-17T00:00:00Z',
      user_id_claim: '00000000-0000-0000-0000-000000000001',
    },
  ],
  session_context: {
    cwd: '/home/user/project',
    git: null,
    is_resume: false,
    mode: 'normal',
  },
};

describe('POST /v1/events', () => {
  it('returns 401 without auth', async () => {
    const deps = makeTestDeps();
    const app = createApp({} as unknown as Config, deps);
    const res = await app.request('/v1/events', {
      body: JSON.stringify(BATCH_FIXTURE),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('returns 202 with valid batch and auth', async () => {
    const deps = makeTestDeps();
    const authTokenStub = deps.db.authToken as unknown as { findFirst: ReturnType<typeof vi.fn> };
    authTokenStub.findFirst = vi.fn().mockResolvedValue({
      expiresAt: null,
      id: 'tok-1',
      kind: 'HOOK',
      revokedAt: null,
      userId: '00000000-0000-0000-0000-000000000001',
    });
    const dbStub = deps.db as unknown as {
      $executeRaw: ReturnType<typeof vi.fn>;
      $queryRaw: ReturnType<typeof vi.fn>;
    };
    // insertEventsBatch now uses RETURNING — surface the inserted id.
    dbStub.$queryRaw = vi
      .fn()
      .mockResolvedValue([{ event_id: '01906a44-0000-7000-8000-000000000001' }]);
    // upsertSessions still uses $executeRaw.
    dbStub.$executeRaw = vi.fn().mockResolvedValue(1);

    const app = createApp({} as unknown as Config, deps);
    const res = await app.request('/v1/events', {
      body: JSON.stringify(BATCH_FIXTURE),
      headers: {
        Authorization: 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toHaveProperty('accepted');
    expect(body).toHaveProperty('request_id');
  });

  it('accepts valid events and drops invalid ones without rejecting the batch', async () => {
    const deps = makeTestDeps();
    const authTokenStub = deps.db.authToken as unknown as { findFirst: ReturnType<typeof vi.fn> };
    authTokenStub.findFirst = vi.fn().mockResolvedValue({
      expiresAt: null,
      id: 'tok-1',
      kind: 'HOOK',
      revokedAt: null,
      userId: '00000000-0000-0000-0000-000000000001',
    });
    const dbStub = deps.db as unknown as {
      $executeRaw: ReturnType<typeof vi.fn>;
      $queryRaw: ReturnType<typeof vi.fn>;
    };
    dbStub.$queryRaw = vi
      .fn()
      .mockResolvedValue([{ event_id: '01906a44-0000-7000-8000-000000000001' }]);
    dbStub.$executeRaw = vi.fn().mockResolvedValue(1);

    // One valid SessionStart + one invalid PostToolUse (missing the required
    // `tool` block). The invalid event must not poison the whole batch.
    const mixedBatch = {
      events: [
        BATCH_FIXTURE.events[0],
        {
          ...BATCH_FIXTURE.events[0],
          event_id: '01906a44-0000-7000-8000-000000000002',
          event_type: 'PostToolUse',
        },
      ],
      session_context: BATCH_FIXTURE.session_context,
    };

    const app = createApp({} as unknown as Config, deps);
    const res = await app.request('/v1/events', {
      body: JSON.stringify(mixedBatch),
      headers: {
        Authorization: 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: number; rejected: number };
    expect(body.rejected).toBe(1);
    expect(body.accepted).toBe(1);
  });

  it('only aggregates accepted (newly-inserted) events, not duplicates', async () => {
    const deps = makeTestDeps();
    const authTokenStub = deps.db.authToken as unknown as { findFirst: ReturnType<typeof vi.fn> };
    authTokenStub.findFirst = vi.fn().mockResolvedValue({
      expiresAt: null,
      id: 'tok-1',
      kind: 'HOOK',
      revokedAt: null,
      userId: '00000000-0000-0000-0000-000000000001',
    });
    const executeRaw = vi.fn().mockResolvedValue(0);
    // Simulate a full-replay retry — every event_id was already inserted before,
    // so RETURNING comes back empty.
    const queryRaw = vi.fn().mockResolvedValue([]);
    const dbStub = deps.db as unknown as {
      $executeRaw: typeof executeRaw;
      $queryRaw: typeof queryRaw;
    };
    dbStub.$executeRaw = executeRaw;
    dbStub.$queryRaw = queryRaw;

    const app = createApp({} as unknown as Config, deps);
    const res = await app.request('/v1/events', {
      body: JSON.stringify(BATCH_FIXTURE),
      headers: {
        Authorization: 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: number; deduped: number };
    expect(body.accepted).toBe(0);
    expect(body.deduped).toBe(1);

    // Critical: upsertSessions's $executeRaw must NOT have been called, because
    // there are no newly-accepted events to aggregate. If it were, the SQL SUM
    // accumulator would double-count session totals on every replay.
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('returns a structured 500 when the DB throws on the hot path', async () => {
    const deps = makeTestDeps();
    const authTokenStub = deps.db.authToken as unknown as { findFirst: ReturnType<typeof vi.fn> };
    authTokenStub.findFirst = vi.fn().mockResolvedValue({
      expiresAt: null,
      id: 'tok-1',
      kind: 'HOOK',
      revokedAt: null,
      userId: '00000000-0000-0000-0000-000000000001',
    });
    const dbStub = deps.db as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    dbStub.$queryRaw = vi.fn().mockRejectedValue(new Error('connection reset'));

    const app = createApp({} as unknown as Config, deps);
    const res = await app.request('/v1/events', {
      body: JSON.stringify(BATCH_FIXTURE),
      headers: {
        Authorization: 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; request_id: string };
    expect(body.error).toBe('Internal server error');
    expect(body.request_id).toBeTruthy();
  });

  it('returns 413 when batch exceeds 500 events', async () => {
    const deps = makeTestDeps();
    const authTokenStub = deps.db.authToken as unknown as { findFirst: ReturnType<typeof vi.fn> };
    authTokenStub.findFirst = vi.fn().mockResolvedValue({
      expiresAt: null,
      id: 'tok-1',
      kind: 'HOOK',
      revokedAt: null,
      userId: '00000000-0000-0000-0000-000000000001',
    });

    const events = Array.from({ length: 501 }, (_, i) => ({
      ...BATCH_FIXTURE.events[0],
      event_id: `01906a44-0000-7000-8000-0000000${String(i).padStart(5, '0')}`,
    }));

    const app = createApp({} as unknown as Config, deps);
    const res = await app.request('/v1/events', {
      body: JSON.stringify({ ...BATCH_FIXTURE, events }),
      headers: {
        Authorization: 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(res.status).toBe(413);
  });
});
