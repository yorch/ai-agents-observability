import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/app';
import { createApp } from '../src/app';
import type { Config } from '../src/config';

const testConfig: Config = {
  database_url: 'postgresql://test:test@localhost:5432/test',
  git_sha: 'abc1234',
  log_level: 'silent',
  node_env: 'test',
  port: 4000,
  s3_access_key_id: 'test',
  s3_bucket: 'test',
  s3_endpoint: 'http://localhost:9000',
  s3_force_path_style: true,
  s3_region: 'us-east-1',
  s3_secret_access_key: 'test',
};

const logger = pino({ level: 'silent' });

function makeApp(overrides?: Partial<AppDeps>) {
  const deps: AppDeps = {
    checkDb: vi.fn().mockResolvedValue(undefined),
    checkS3: vi.fn().mockResolvedValue(undefined),
    db: { authToken: { findFirst: vi.fn().mockResolvedValue(null) } } as AppDeps['db'],
    logger,
    ...overrides,
  };
  return { app: createApp(testConfig, deps), deps };
}

// ── /health ──────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with ok:true and version', async () => {
    const { app } = makeApp();
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; uptime_s: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('abc1234');
    expect(typeof body.uptime_s).toBe('number');
  });

  it('sets x-request-id header', async () => {
    const { app } = makeApp();
    const res = await app.request('/health');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('echoes back a provided x-request-id', async () => {
    const { app } = makeApp();
    const res = await app.request('/health', { headers: { 'x-request-id': 'test-req-id' } });
    expect(res.headers.get('x-request-id')).toBe('test-req-id');
  });
});

// ── /readyz ───────────────────────────────────────────────────────────────────

describe('GET /readyz', () => {
  it('returns 200 when both checks pass', async () => {
    const { app } = makeApp();
    const res = await app.request('/readyz');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: { postgres: string; s3: string } };
    expect(body.ok).toBe(true);
    expect(body.checks.postgres).toBe('ok');
    expect(body.checks.s3).toBe('ok');
  });

  it('returns 503 when postgres check fails', async () => {
    const { app } = makeApp({ checkDb: vi.fn().mockRejectedValue(new Error('db down')) });
    const res = await app.request('/readyz');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: { postgres: string } };
    expect(body.ok).toBe(false);
    expect(body.checks.postgres).toBe('error');
  });

  it('returns 503 when s3 check fails', async () => {
    const { app } = makeApp({ checkS3: vi.fn().mockRejectedValue(new Error('s3 down')) });
    const res = await app.request('/readyz');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: { s3: string } };
    expect(body.ok).toBe(false);
    expect(body.checks.s3).toBe('error');
  });
});
