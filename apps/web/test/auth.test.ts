import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = new Map<string, { value: string }>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => cookieStore.set(name, { value }),
  }),
}));

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => ({
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === 'u1') {
          return {
            createdAt: new Date(),
            deactivatedAt: null,
            displayName: 'Jorge',
            email: 'jorge@example.com',
            githubId: 1n,
            githubLogin: 'jorge',
            id: 'u1',
            lastSeenAt: null,
            primaryTeamId: null,
          };
        }
        return null;
      }),
    },
  })),
}));

vi.mock('@ai-agents-observability/auth', () => ({
  verifyAccessToken: vi.fn(async (token: string) => {
    if (token === 'good') {
      return { kind: 'access', userId: 'u1' };
    }
    throw new Error('bad token');
  }),
}));

beforeEach(() => {
  cookieStore.clear();
  // getPrisma() reads DATABASE_URL on first call; provide a placeholder so the
  // lazy client constructs without requireEnv throwing.
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

describe('sanitizeNext', () => {
  it('passes same-origin absolute paths', async () => {
    const { sanitizeNext } = await import('../src/lib/session-cookie.js');
    expect(sanitizeNext('/me/sessions/abc')).toBe('/me/sessions/abc');
    expect(sanitizeNext('/')).toBe('/');
  });

  it('rejects protocol-relative and absolute URLs (open-redirect guard)', async () => {
    const { sanitizeNext } = await import('../src/lib/session-cookie.js');
    expect(sanitizeNext('//evil.example/x')).toBeNull();
    expect(sanitizeNext('https://evil.example/x')).toBeNull();
    expect(sanitizeNext('javascript:alert(1)')).toBeNull();
    expect(sanitizeNext('')).toBeNull();
    expect(sanitizeNext(undefined)).toBeNull();
    expect(sanitizeNext(null)).toBeNull();
  });
});

describe('currentUser', () => {
  it('returns null when no cookie is set', async () => {
    const { currentUser } = await import('../src/lib/auth.js');
    const user = await currentUser();
    expect(user).toBeNull();
  });

  it('returns the user when the cookie verifies', async () => {
    const headers = await import('next/headers');
    const jar = await headers.cookies();
    jar.set('cc_access', 'good');

    const { currentUser } = await import('../src/lib/auth.js');
    const user = await currentUser();
    expect(user?.displayName).toBe('Jorge');
  });

  it('returns null when the token is invalid', async () => {
    const headers = await import('next/headers');
    const jar = await headers.cookies();
    jar.set('cc_access', 'bad');

    const { currentUser } = await import('../src/lib/auth.js');
    const user = await currentUser();
    expect(user).toBeNull();
  });
});
