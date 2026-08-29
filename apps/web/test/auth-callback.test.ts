import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearOAuthCookies: vi.fn(),
  completeAuthorize: vi.fn(),
  consumeNextCookie: vi.fn(),
  ensureVisibilityPolicy: vi.fn(),
  fetchTeams: vi.fn(),
  getStateCookie: vi.fn(),
  issueAccessToken: vi.fn(),
  issueRefreshToken: vi.fn(),
  requestId: '917ae065-bc20-4c85-8fe1-028bcb440839',
  setAuthCookies: vi.fn(),
  syncLoginTeams: vi.fn(),
  userUpsert: vi.fn(),
}));

vi.mock('@ai-agents-observability/auth', () => ({
  issueAccessToken: mocks.issueAccessToken,
  issueRefreshToken: mocks.issueRefreshToken,
}));

vi.mock('@/lib/api-logging', () => ({
  jsonError: (error: string, status: number) =>
    Response.json({ error, request_id: mocks.requestId }, { status }),
  withRouteLogging: (_route: string, handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock('@/lib/auth-provider', () => ({
  getProvider: () => ({
    completeAuthorize: mocks.completeAuthorize,
    fetchTeams: mocks.fetchTeams,
  }),
}));

vi.mock('@/lib/config', () => ({
  getConfig: () => ({ appBaseUrl: 'https://app.example.com', isProduction: true }),
}));

vi.mock('@/lib/ensure-visibility-policy', () => ({
  ensureVisibilityPolicy: mocks.ensureVisibilityPolicy,
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/oauth-errors', async () => await import('../src/lib/oauth-errors'));

vi.mock('@/lib/oauth-origin', () => ({
  oauthCallbackUrl: () => 'https://app.example.com/api/auth/callback',
  publicAppOrigin: () => 'https://app.example.com',
}));

vi.mock('@/lib/prisma', () => ({
  getPrisma: () => ({ user: { upsert: mocks.userUpsert } }),
}));

vi.mock('@/lib/request-context', () => ({
  getRequestId: () => mocks.requestId,
}));

vi.mock('@/lib/session-cookie', () => ({
  clearOAuthCookies: mocks.clearOAuthCookies,
  consumeNextCookie: mocks.consumeNextCookie,
  getStateCookie: mocks.getStateCookie,
  hashState: (state: string) => `hashed-${state}`,
  setAuthCookies: mocks.setAuthCookies,
}));

vi.mock('@/lib/sync-login-teams', () => ({
  syncLoginTeams: mocks.syncLoginTeams,
}));

import { GET } from '../src/app/api/auth/callback/route';

function callbackRequest(query = ''): Request {
  return new Request(`https://app.example.com/api/auth/callback${query}`);
}

function errorLocation(response: Response): URL {
  expect(response.status).toBe(302);
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  return new URL(location as string, 'https://app.example.com');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clearOAuthCookies.mockResolvedValue(undefined);
  mocks.completeAuthorize.mockResolvedValue({
    display_name: 'User',
    email: 'user@example.com',
    external_id: '1',
    raw: { login: 'user' },
  });
  mocks.consumeNextCookie.mockResolvedValue(null);
  mocks.ensureVisibilityPolicy.mockResolvedValue(undefined);
  mocks.fetchTeams.mockResolvedValue([]);
  mocks.getStateCookie.mockResolvedValue('hashed-state');
  mocks.issueAccessToken.mockResolvedValue('access');
  mocks.issueRefreshToken.mockResolvedValue('refresh');
  mocks.setAuthCookies.mockResolvedValue(undefined);
  mocks.syncLoginTeams.mockResolvedValue(undefined);
  mocks.userUpsert.mockResolvedValue({ id: 'user-id' });
});

describe('GitHub OAuth callback errors', () => {
  it('redirects an invalid callback request to the login page', async () => {
    const location = errorLocation(await GET(callbackRequest()));

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('auth_error')).toBe('invalid_request');
    expect(location.searchParams.get('request_id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.clearOAuthCookies).toHaveBeenCalledOnce();
  });

  it('redirects a state mismatch without reflecting the state', async () => {
    mocks.getStateCookie.mockResolvedValue('different');
    const location = errorLocation(
      await GET(callbackRequest('?code=secret-code&state=secret-state')),
    );

    expect(location.searchParams.get('auth_error')).toBe('invalid_state');
    expect(location.href).not.toContain('secret-code');
    expect(location.href).not.toContain('secret-state');
    expect(mocks.clearOAuthCookies).toHaveBeenCalledOnce();
  });

  it('redirects a provider exchange failure with a safe error code', async () => {
    mocks.completeAuthorize.mockRejectedValue(new Error('provider response detail'));
    const location = errorLocation(await GET(callbackRequest('?code=code&state=state')));

    expect(location.searchParams.get('auth_error')).toBe('provider');
    expect(location.href).not.toContain('provider response detail');
    expect(mocks.clearOAuthCookies).toHaveBeenCalledOnce();
  });

  it('redirects an unexpected callback exception instead of returning JSON', async () => {
    mocks.userUpsert.mockRejectedValue(new Error('database detail'));
    const response = await GET(callbackRequest('?code=code&state=state'));
    const location = errorLocation(response);

    expect(response.headers.get('content-type')).toBeNull();
    expect(location.searchParams.get('auth_error')).toBe('unexpected');
    expect(location.href).not.toContain('database detail');
    expect(mocks.clearOAuthCookies).toHaveBeenCalledOnce();
  });
});
