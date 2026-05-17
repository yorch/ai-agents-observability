import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { makeTestDeps } from './helpers.js';

const BATCH_FIXTURE = {
  session_context: {
    cwd: '/home/user/project',
    git: null,
    is_resume: false,
    mode: 'normal',
  },
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
};

describe('POST /v1/events', () => {
  it('returns 401 without auth', async () => {
    const deps = makeTestDeps();
    const app = createApp({} as any, deps);
    const res = await app.request('/v1/events', { method: 'POST', body: JSON.stringify(BATCH_FIXTURE), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(401);
  });

  it('returns 202 with valid batch and auth', async () => {
    const deps = makeTestDeps();
    (deps.db.authToken as any).findFirst = vi.fn().mockResolvedValue({
      id: 'tok-1',
      userId: '00000000-0000-0000-0000-000000000001',
      kind: 'hook',
      expiresAt: null,
      revokedAt: null,
    });
    (deps.db as any).$executeRaw = vi.fn().mockResolvedValue(1);

    const app = createApp({} as any, deps);
    const res = await app.request('/v1/events', {
      method: 'POST',
      body: JSON.stringify(BATCH_FIXTURE),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toHaveProperty('accepted');
    expect(body).toHaveProperty('request_id');
  });

  it('returns 413 when batch exceeds 500 events', async () => {
    const deps = makeTestDeps();
    (deps.db.authToken as any).findFirst = vi.fn().mockResolvedValue({
      id: 'tok-1',
      userId: '00000000-0000-0000-0000-000000000001',
      kind: 'hook',
      expiresAt: null,
      revokedAt: null,
    });

    const events = Array.from({ length: 501 }, (_, i) => ({
      ...BATCH_FIXTURE.events[0],
      event_id: `01906a44-0000-7000-8000-0000000${String(i).padStart(5, '0')}`,
    }));

    const app = createApp({} as any, deps);
    const res = await app.request('/v1/events', {
      method: 'POST',
      body: JSON.stringify({ ...BATCH_FIXTURE, events }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    expect(res.status).toBe(413);
  });
});
