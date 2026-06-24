import { createHash } from 'node:crypto';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/app';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { verifyIdentityClaim } from '../src/lib/identity';

const testConfig: Config = {
  database_url: 'postgresql://test:test@localhost:5432/test',
  git_sha: 'test',
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

// ── Token store helpers ───────────────────────────────────────────────────────

type FakeToken = {
  expiresAt: Date | null;
  id: string;
  kind: 'ACCESS' | 'HOOK' | 'REFRESH';
  revokedAt: Date | null;
  tokenHash: string;
  userId: string;
};

const VALID_TOKEN = 'cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_USER_ID = 'user-aaa-111';

function makeTokenStore(overrides?: Partial<FakeToken>) {
  const tokenHash = createHash('sha256').update(VALID_TOKEN).digest('hex');
  const record: FakeToken = {
    expiresAt: new Date(Date.now() + 3_600_000),
    id: crypto.randomUUID(),
    kind: 'HOOK',
    revokedAt: null,
    tokenHash,
    userId: VALID_USER_ID,
    ...overrides,
  };
  return new Map([[tokenHash, record]]);
}

function makeDb(store: Map<string, FakeToken>) {
  return {
    authToken: {
      findFirst: vi.fn(
        async ({ where }: { where: { tokenHash: string } }) => store.get(where.tokenHash) ?? null,
      ),
    },
  };
}

function makeApp(store: Map<string, FakeToken>) {
  const deps: AppDeps = {
    checkDb: vi.fn().mockResolvedValue(undefined),
    checkS3: vi.fn().mockResolvedValue(undefined),
    db: makeDb(store) as AppDeps['db'],
    logger,
  };
  const app = createApp(testConfig, deps);
  // Add a simple protected test route
  app.get('/v1/ping', (c) => c.json({ userId: c.get('user')?.id }));
  return app;
}

// ── Auth middleware ───────────────────────────────────────────────────────────

describe('authRequired', () => {
  it('returns 401 with no Authorization header', async () => {
    const app = makeApp(makeTokenStore());
    const res = await app.request('/v1/ping');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a non-Bearer scheme', async () => {
    const app = makeApp(makeTokenStore());
    const res = await app.request('/v1/ping', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a token that lacks the cct_ prefix', async () => {
    const app = makeApp(makeTokenStore());
    const res = await app.request('/v1/ping', {
      headers: { Authorization: 'Bearer not-a-cct-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is not in the store', async () => {
    const app = makeApp(makeTokenStore());
    const res = await app.request('/v1/ping', {
      headers: { Authorization: 'Bearer cct_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a revoked token', async () => {
    const store = makeTokenStore({ revokedAt: new Date(Date.now() - 1000) });
    const app = makeApp(store);
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const store = makeTokenStore({ expiresAt: new Date(Date.now() - 1000) });
    const app = makeApp(store);
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('sets c.user and returns 200 for a valid token', async () => {
    const app = makeApp(makeTokenStore());
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe(VALID_USER_ID);
  });

  it('serves the cached user on a second request without a DB hit', async () => {
    const store = makeTokenStore();
    const db = makeDb(store);
    const deps: AppDeps = {
      checkDb: vi.fn().mockResolvedValue(undefined),
      checkS3: vi.fn().mockResolvedValue(undefined),
      db: db as AppDeps['db'],
      logger,
    };
    const app = createApp(testConfig, deps);
    app.get('/v1/ping', (c) => c.json({ ok: true }));

    await app.request('/v1/ping', { headers: { Authorization: `Bearer ${VALID_TOKEN}` } });
    await app.request('/v1/ping', { headers: { Authorization: `Bearer ${VALID_TOKEN}` } });

    // DB should only be hit once; second request hits cache
    expect(db.authToken.findFirst).toHaveBeenCalledOnce();
  });
});

// ── verifyIdentityClaim ───────────────────────────────────────────────────────

describe('verifyIdentityClaim', () => {
  it('returns token user_id when claim matches', async () => {
    const app = makeApp(makeTokenStore());
    app.get('/v1/claim-match', (c) => {
      const userId = verifyIdentityClaim(c, VALID_USER_ID, logger);
      return c.json({ userId });
    });

    const res = await app.request('/v1/claim-match', {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe(VALID_USER_ID);
  });

  it('returns token user_id and logs a warning when claim mismatches', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const app = makeApp(makeTokenStore());
    app.get('/v1/claim-mismatch', (c) => {
      const userId = verifyIdentityClaim(c, 'github:impostor', logger);
      return c.json({ userId });
    });

    const res = await app.request('/v1/claim-mismatch', {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    // Always returns token identity, never claim
    expect(body.userId).toBe(VALID_USER_ID);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'suspicious_identity_claim' }),
      expect.any(String),
    );
  });
});
