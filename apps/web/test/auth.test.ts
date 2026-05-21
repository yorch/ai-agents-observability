import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => {
  const store = new Map<string, { value: string }>();
  return {
    __store: store,
    cookies: async () => ({
      get: (name: string) => store.get(name),
      set: (name: string, value: string) => store.set(name, { value }),
    }),
  };
});

vi.mock('@ai-agents-observability/db', () => ({
  prisma: {
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
  },
}));

vi.mock('@ai-agents-observability/auth', () => ({
  verifyAccessToken: vi.fn(async (token: string) => {
    if (token === 'good') {
      return { kind: 'access', userId: 'u1' };
    }
    throw new Error('bad token');
  }),
}));

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
