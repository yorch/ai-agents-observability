import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types';
import { rateLimitMiddleware } from './rate-limit';

function makeApp(trustedProxyCount?: number) {
  const app = new Hono<AppEnv>();
  app.use('*', rateLimitMiddleware(trustedProxyCount));
  app.get('/limited', (c) => c.json({ ok: true }));
  return app;
}

describe('rateLimitMiddleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows requests below the per-minute limit', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const app = makeApp(1);

    const res = await app.request('/limited', {
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 429 with Retry-After after 1000 requests from the same IP in a window', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const app = makeApp(1);

    for (let i = 0; i < 1_000; i++) {
      const res = await app.request('/limited', {
        headers: { 'x-forwarded-for': '203.0.113.2, 10.0.0.1' },
      });
      expect(res.status).toBe(200);
    }

    const limited = await app.request('/limited', {
      headers: { 'x-forwarded-for': '203.0.113.2, 10.0.0.1' },
    });

    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(await limited.json()).toEqual({ error: 'Too Many Requests' });
  });

  it('tracks each client IP independently', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const app = makeApp(1);

    for (let i = 0; i < 1_000; i++) {
      await app.request('/limited', {
        headers: { 'x-forwarded-for': '203.0.113.3, 10.0.0.1' },
      });
    }

    const otherIp = await app.request('/limited', {
      headers: { 'x-forwarded-for': '203.0.113.4, 10.0.0.1' },
    });

    expect(otherIp.status).toBe(200);
  });

  it('starts a new window after sixty seconds', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const app = makeApp(1);

    for (let i = 0; i < 1_000; i++) {
      await app.request('/limited', {
        headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
      });
    }

    now.mockReturnValue(61_000);
    const res = await app.request('/limited', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });

    expect(res.status).toBe(200);
  });
});
