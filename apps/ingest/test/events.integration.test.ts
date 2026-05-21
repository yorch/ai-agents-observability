import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { makeTestDeps } from './helpers';

const BATCH_FIXTURE = {
  events: [
    {
      agent_type: 'claude-code',
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
      kind: 'hook',
      revokedAt: null,
      userId: '00000000-0000-0000-0000-000000000001',
    });
    const dbStub = deps.db as unknown as { $executeRaw: ReturnType<typeof vi.fn> };
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

  it('returns 413 when batch exceeds 500 events', async () => {
    const deps = makeTestDeps();
    const authTokenStub = deps.db.authToken as unknown as { findFirst: ReturnType<typeof vi.fn> };
    authTokenStub.findFirst = vi.fn().mockResolvedValue({
      expiresAt: null,
      id: 'tok-1',
      kind: 'hook',
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
