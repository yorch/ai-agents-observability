import { describe, expect, it, vi } from 'vitest';

import { adminRouter } from '../src/routes/admin';

const SECRET = 'test-secret-1234567890';
const JOB_NAME = 'sweep-scratch';

function makeDb() {
  return {
    auditLog: { create: vi.fn(async () => ({})) },
    jobConfig: { upsert: vi.fn(async () => ({})) },
  };
}

async function callAdmin(
  db: ReturnType<typeof makeDb>,
  secret: string | undefined,
  headers: Record<string, string> = {},
  jobName: string = JOB_NAME,
) {
  const router = adminRouter(db as never, secret);
  const app = router as unknown as { request: (path: string, init?: unknown) => Promise<Response> };
  // Hono routers can be called directly via .request()
  return app.request(`/jobs/${jobName}/run`, {
    body: '',
    headers,
    method: 'POST',
  });
}

describe('admin router security', () => {
  it('returns 404 when no secret is configured', async () => {
    const db = makeDb();
    const res = await callAdmin(db, undefined, {});
    expect(res.status).toBe(404);
  });

  it('returns 401 for a wrong-length secret', async () => {
    const db = makeDb();
    const res = await callAdmin(db, SECRET, { 'x-admin-secret': 'short' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a wrong secret with the same length', async () => {
    const db = makeDb();
    const res = await callAdmin(db, SECRET, {
      'x-admin-secret': 'wrong-secret-1234567890',
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 for the correct secret', async () => {
    const db = makeDb();
    const res = await callAdmin(db, SECRET, { 'x-admin-secret': SECRET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobName: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.jobName).toBe(JOB_NAME);
  });

  it('writes an audit log entry on success', async () => {
    const db = makeDb();
    await callAdmin(db, SECRET, { 'x-admin-secret': SECRET });
    expect(db.auditLog.create).toHaveBeenCalledOnce();
    const calls = db.auditLog.create.mock.calls as unknown as [
      [{ data: { action: string; actorUserId: string | null; ip: string } }],
    ];
    expect(calls.length).toBe(1);
    expect(calls[0][0].data.action).toBe('ADMIN_JOB_TRIGGERED');
    expect(calls[0][0].data.actorUserId).toBeNull();
  });

  it('returns 400 for an unknown job name', async () => {
    const db = makeDb();
    const res = await callAdmin(db, SECRET, { 'x-admin-secret': SECRET }, 'nonexistent-job');
    expect(res.status).toBe(400);
  });
});
