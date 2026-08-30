import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureVisibilityPolicy: vi.fn(),
  issueAccessToken: vi.fn(),
  issueRefreshToken: vi.fn(),
  requestId: '917ae065-bc20-4c85-8fe1-028bcb440839',
  setAuthCookies: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('@ai-agents-observability/auth', () => ({
  hashPassword: vi.fn(async () => 'dummy-hash'),
  issueAccessToken: mocks.issueAccessToken,
  issueRefreshToken: mocks.issueRefreshToken,
  verifyPassword: mocks.verifyPassword,
}));

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => ({})),
  Prisma: {
    empty: { strings: [''], values: [] },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
  withInteractiveOnly: <T>(c: T): T => c,
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: vi.fn() })),
}));

vi.mock('@/lib/api-logging', () => ({
  jsonError: (error: string, status: number) =>
    Response.json({ error, request_id: mocks.requestId }, { status }),
  withRouteLogging: (_route: string, handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock('@/lib/ensure-visibility-policy', () => ({
  ensureVisibilityPolicy: mocks.ensureVisibilityPolicy,
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
  getPrisma: () => ({
    user: {
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
    },
  }),
}));

vi.mock('@/lib/request-context', () => ({
  getRequestId: () => mocks.requestId,
}));

vi.mock('@/lib/request-meta', () => ({
  clientIp: (headers: Headers) => headers.get('x-forwarded-for'),
}));

vi.mock('@/lib/session-cookie', () => ({
  sanitizeNext: (value: string | null) =>
    value?.startsWith('/') && !value.startsWith('//') ? value : null,
  setAuthCookies: mocks.setAuthCookies,
}));

// Real in-process rate limiter — state is cleared in beforeEach via __clearAll.
vi.mock('@/lib/login-rate-limit', () => {
  const failures = new Map<string, { count: number; firstTs: number }>();
  const WINDOW_MS = 15 * 60 * 1_000;
  const MAX_FAILURES = 5;
  const MAX_TRACKED = 10_000;
  function evictStale(): void {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, entry] of failures) {
      if (entry.firstTs < cutoff) {
        failures.delete(key);
      }
    }
  }
  function rateKey(ip: string | null, email: string): string {
    return `${ip ?? 'unknown'}:${email.toLowerCase()}`;
  }
  return {
    __clearAll: (): void => {
      failures.clear();
    },
    checkLoginRateLimit: (ip: string | null, email: string): number | null => {
      evictStale();
      if (failures.size >= MAX_TRACKED) {
        evictStale();
      }
      const entry = failures.get(rateKey(ip, email));
      if (entry && entry.count >= MAX_FAILURES) {
        return Math.ceil((entry.firstTs + WINDOW_MS - Date.now()) / 1_000);
      }
      return null;
    },
    recordLoginFailure: (ip: string | null, email: string): void => {
      const key = rateKey(ip, email);
      const entry = failures.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        failures.set(key, { count: 1, firstTs: Date.now() });
      }
    },
    resetLoginRateLimit: (ip: string | null, email: string): void => {
      failures.delete(rateKey(ip, email));
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMAIL = 'user@example.com';
const PASSWORD = 'correct-horse-battery-staple';

function makeRequest(ip: string, email: string = EMAIL, password: string = PASSWORD): Request {
  const headers = new Headers();
  if (ip) {
    headers.set('x-forwarded-for', ip);
  }
  return new Request('http://localhost/api/auth/password', {
    body: JSON.stringify({ email, password }),
    headers,
    method: 'POST',
  });
}

const VALID_USER = {
  createdAt: new Date(),
  deactivatedAt: null,
  displayName: 'Test User',
  email: EMAIL,
  githubId: null,
  githubLogin: 'testuser',
  id: 'u-1',
  lastSeenAt: null,
  passwordHash: 'hashed',
  primaryTeamId: null,
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';

  // Clear the rate limiter's in-memory state between tests.
  const { __clearAll } = await import('@/lib/login-rate-limit');
  __clearAll();

  // Default mocks: valid user, password verifies, token issuance succeeds.
  mocks.userFindUnique.mockResolvedValue(VALID_USER);
  mocks.userUpdate.mockResolvedValue(VALID_USER);
  mocks.ensureVisibilityPolicy.mockResolvedValue(undefined);
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.issueAccessToken.mockResolvedValue('access-token');
  mocks.issueRefreshToken.mockResolvedValue('refresh-token');
  mocks.setAuthCookies.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('password login rate limiting', () => {
  it('allows 5 failed attempts then returns 429 on the 6th', async () => {
    // Simulate invalid credentials for every attempt.
    mocks.verifyPassword.mockResolvedValue(false);
    mocks.userFindUnique.mockResolvedValue(VALID_USER);

    const { POST } = await import('../src/app/api/auth/password/route.js');

    for (let i = 0; i < 5; i++) {
      const res = await POST(makeRequest('1.2.3.4'));
      expect(res.status).toBe(401);
    }

    const res6 = await POST(makeRequest('1.2.3.4'));
    expect(res6.status).toBe(429);
    expect(res6.headers.get('Retry-After')).toBeTruthy();
  });

  it('resets the counter after a successful login', async () => {
    // First 4 attempts fail.
    mocks.verifyPassword.mockResolvedValue(false);
    const { POST } = await import('../src/app/api/auth/password/route.js');

    for (let i = 0; i < 4; i++) {
      const res = await POST(makeRequest('5.6.7.8'));
      expect(res.status).toBe(401);
    }

    // 5th attempt succeeds — resets the counter.
    mocks.verifyPassword.mockResolvedValue(true);
    const resOk = await POST(makeRequest('5.6.7.8'));
    expect(resOk.status).toBe(200);

    // After reset, 5 more failures should still be allowed (not 429 on the 5th).
    mocks.verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      const res = await POST(makeRequest('5.6.7.8'));
      expect(res.status).toBe(401);
    }
  });

  it('tracks different IPs as separate counters', async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    const { POST } = await import('../src/app/api/auth/password/route.js');

    // Exhaust the limit for IP 1.2.3.4.
    for (let i = 0; i < 6; i++) {
      const res = await POST(makeRequest('1.2.3.4'));
      if (i < 5) {
        expect(res.status).toBe(401);
      } else {
        expect(res.status).toBe(429);
      }
    }

    // A different IP should still be able to attempt.
    const res = await POST(makeRequest('9.8.7.6'));
    expect(res.status).toBe(401);
  });

  it('tracks different emails as separate counters', async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    const { POST } = await import('../src/app/api/auth/password/route.js');

    // Exhaust the limit for user@example.com from IP 1.2.3.4.
    for (let i = 0; i < 6; i++) {
      const res = await POST(makeRequest('1.2.3.4', 'user@example.com'));
      if (i < 5) {
        expect(res.status).toBe(401);
      } else {
        expect(res.status).toBe(429);
      }
    }

    // A different email from the same IP should still be able to attempt.
    const res = await POST(makeRequest('1.2.3.4', 'other@example.com'));
    expect(res.status).toBe(401);
  });
});
