import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../types';

const WINDOW_MS = 60_000;
const LIMIT = 1_000;

type WindowEntry = { count: number; windowStart: number };

// Resolves the client IP from the X-Forwarded-For header, taking the
// Nth-from-right entry when trustedProxyCount is set (the standard approach for
// trusted proxy chains). When trustedProxyCount is unset, XFF is ignored
// entirely — a client can spoof it to bypass rate limits, so it is only trusted
// when the operator has explicitly configured the proxy depth. Falls back to the
// socket remote address, then 'unknown'.
function getClientIp(
  req: { header: (name: string) => string | undefined },
  remoteAddr: string | undefined,
  trustedProxyCount?: number,
): string {
  if (trustedProxyCount !== undefined && trustedProxyCount > 0) {
    const fwd = req.header('x-forwarded-for');
    if (fwd) {
      const hops = fwd.split(',').map((s) => s.trim());
      // The client IP is Nth-from-right, where N = trustedProxyCount.
      // With 1 trusted proxy: "client, proxy" → hops[0] = client.
      const idx = hops.length - trustedProxyCount - 1;
      if (idx >= 0 && hops[idx]) {
        return hops[idx];
      }
    }
  }
  return remoteAddr ?? 'unknown';
}

const MAX_TRACKED_IPS = 10_000;

export function rateLimitMiddleware(trustedProxyCount?: number): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, WindowEntry>();

  function pruneStale(now: number): void {
    for (const [k, v] of windows) {
      if (now - v.windowStart >= WINDOW_MS) {
        windows.delete(k);
      }
    }
  }

  return async (c, next) => {
    // Bun's Hono request doesn't expose the raw socket address directly in a
    // portable way. c.env may carry it depending on the adapter; fall back to
    // 'unknown' when unavailable (e.g. in tests).
    const remoteAddr =
      (c.env as { remoteAddr?: { address?: string } } | undefined)?.remoteAddr?.address ??
      undefined;
    const ip = getClientIp(c.req, remoteAddr, trustedProxyCount);
    const now = Date.now();
    const entry = windows.get(ip);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      if (windows.size >= MAX_TRACKED_IPS) {
        pruneStale(now);
      }
      windows.set(ip, { count: 1, windowStart: now });
    } else if (entry.count >= LIMIT) {
      const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Too Many Requests' }, 429);
    } else {
      entry.count++;
    }

    return await next();
  };
}

// Exported for testing.
export { getClientIp };
