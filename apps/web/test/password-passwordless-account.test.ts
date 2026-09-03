import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: an account with no password could be signed into with the literal
 * string `__sentinel__`.
 *
 * `/api/auth/password` equalized response time by comparing the submitted
 * password against a dummy hash when the user had none:
 *
 *   verifyPassword(password, user?.passwordHash ?? await getDummyHash())
 *
 * The dummy hash was `hashPassword('__sentinel__')` — a KNOWN plaintext — so
 * submitting that string verified true, `user` was non-null, and the route
 * issued real access and refresh cookies. Every GitHub-OAuth and device-flow
 * account was affected, since those never set a password.
 *
 * The sibling route `/api/auth/token` already carried the guard AND a comment
 * naming this exact attack; it was simply never applied here.
 *
 * The existing password-rate-limit suite cannot catch this: it mocks
 * `@ai-agents-observability/auth`, stubbing `hashPassword` to a constant and
 * `verifyPassword` to a `vi.fn()`, so the real comparison never runs. **This
 * file therefore uses the REAL crypto** — that is the whole point of it. Do not
 * add a mock for `@ai-agents-observability/auth` here.
 */

const mocks = vi.hoisted(() => ({
  ensureVisibilityPolicy: vi.fn(),
  requestId: 'a2ef1e4f-6f2b-4a2c-8a9f-5f3c2b1d0e7a',
  setAuthCookies: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => ({})),
  Prisma: {
    empty: { strings: [''], values: [] },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
  withInteractiveOnly: <T>(c: T): T => c,
}));

vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ set: vi.fn() })) }));

vi.mock('@/lib/api-logging', () => ({
  jsonError: (error: string, status: number) => Response.json({ error }, { status }),
  withRouteLogging: (_route: string, handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock('@/lib/ensure-visibility-policy', () => ({
  ensureVisibilityPolicy: mocks.ensureVisibilityPolicy,
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
  getPrisma: () => ({ user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate } }),
}));

// Rate limiting is not what this file tests — keep it permissive so a 401 here
// always means "credentials rejected", never "throttled".
vi.mock('@/lib/login-rate-limit', () => ({
  checkLoginRateLimit: () => null,
  recordLoginFailure: vi.fn(),
  resetLoginRateLimit: vi.fn(),
}));

vi.mock('@/lib/request-context', () => ({ getRequestId: () => mocks.requestId }));
vi.mock('@/lib/request-meta', () => ({
  clientIp: (headers: Headers) => headers.get('x-forwarded-for'),
}));
vi.mock('@/lib/session-cookie', () => ({
  sanitizeNext: (value: string | null) =>
    value?.startsWith('/') && !value.startsWith('//') ? value : null,
  setAuthCookies: mocks.setAuthCookies,
}));

function post(email: string, password: string, ip = '198.51.100.7'): Request {
  return new Request('http://localhost/api/auth/password', {
    body: JSON.stringify({ email, password }),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    method: 'POST',
  });
}

/** A real user row that has never set a password — i.e. every OAuth account. */
const PASSWORDLESS_USER = {
  deactivatedAt: null,
  email: 'oauth-user@example.com',
  id: 'b1d2c3e4-5f60-4718-9a2b-3c4d5e6f7a8b',
  passwordHash: null,
};

describe('POST /api/auth/password — accounts with no password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindUnique.mockResolvedValue(PASSWORDLESS_USER);
  });

  it('rejects the sentinel string that used to authenticate as the user', async () => {
    const { POST } = await import('../src/app/api/auth/password/route');
    const res = await POST(post(PASSWORDLESS_USER.email, '__sentinel__') as never);

    expect(res.status).toBe(401);
    expect(mocks.setAuthCookies).not.toHaveBeenCalled();
  });

  // The invariant is "never authenticates", not a particular status: an empty
  // password is a 400 from the zod schema before auth is reached, which is also
  // fine. What must never happen is a session.
  it.each(['', ' ', 'hunter2', '__sentinel__', 'undefined', 'null'])(
    'never authenticates %j for a passwordless account',
    async (password) => {
      const { POST } = await import('../src/app/api/auth/password/route');
      const res = await POST(post(PASSWORDLESS_USER.email, password) as never);

      expect(res.status).not.toBe(200);
      expect(mocks.setAuthCookies).not.toHaveBeenCalled();
    },
  );

  it('never issues cookies for a passwordless account, whatever is submitted', async () => {
    const { POST } = await import('../src/app/api/auth/password/route');
    for (const password of ['__sentinel__', 'a', 'x'.repeat(200)]) {
      const res = await POST(post(PASSWORDLESS_USER.email, password) as never);
      expect(res.status).toBe(401);
    }
    expect(mocks.setAuthCookies).not.toHaveBeenCalled();
    expect(mocks.ensureVisibilityPolicy).not.toHaveBeenCalled();
  });
});

describe('the property that made the bypass possible', () => {
  // Guards the reasoning rather than the route: if a dummy hash is ever again
  // derived from a known plaintext, that plaintext becomes a valid password
  // wherever the hash is used as a comparison target.
  it('verifyPassword returns true for the plaintext a hash was built from', async () => {
    const { hashPassword, verifyPassword } = await import('@ai-agents-observability/auth');
    const hash = await hashPassword('__sentinel__');

    expect(await verifyPassword('__sentinel__', hash)).toBe(true);
    expect(await verifyPassword('something-else', hash)).toBe(false);
  });
});
