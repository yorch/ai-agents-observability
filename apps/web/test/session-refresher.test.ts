import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REFRESH_INTERVAL_MS,
  REFRESH_PATH,
  refreshSession,
} from '../src/components/SessionRefresher';

// The SessionRefresher is a side-effect-only client component. We test the
// extracted refreshSession function and the exported constants directly —
// the React effect wiring (setInterval + addEventListener) is straightforward
// and verified by the component rendering without errors in the build.

describe('SessionRefresher constants', () => {
  it('refreshes 30 min before the 8-hour access token expires', () => {
    // 7.5 hours = 7.5 * 60 * 60 * 1000 ms. This must be less than the 8-hour
    // access token TTL (packages/auth/src/tokens.ts:ACCESS_TOKEN_TTL_MS).
    expect(REFRESH_INTERVAL_MS).toBe(7.5 * 60 * 60 * 1000);
    expect(REFRESH_INTERVAL_MS).toBeLessThan(8 * 60 * 60 * 1000);
  });

  it('targets the refresh endpoint', () => {
    expect(REFRESH_PATH).toBe('/api/auth/refresh');
  });
});

describe('refreshSession', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { href: '' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls POST /api/auth/refresh with same-origin credentials', async () => {
    await refreshSession();
    expect(fetchMock).toHaveBeenCalledWith(REFRESH_PATH, {
      credentials: 'same-origin',
      method: 'POST',
    });
  });

  it('returns true on a 2xx response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const result = await refreshSession();
    expect(result).toBe(true);
  });

  it('redirects to /login on 401 and returns false', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const result = await refreshSession();
    expect(result).toBe(false);
    expect(window.location.href).toBe('/login');
  });

  it('returns false on a 5xx server error — the next interval retries', async () => {
    fetchMock.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    const result = await refreshSession();
    expect(result).toBe(false);
    expect(window.location.href).toBe('');
  });

  it('returns false on a network error — swallows it for retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await refreshSession();
    expect(result).toBe(false);
  });
});
