import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../types.js';

const WINDOW_MS = 60_000;
const LIMIT = 1_000;

type WindowEntry = { count: number; windowStart: number };

function getClientIp(req: { header: (name: string) => string | undefined }): string {
  return (
    req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? req.header('x-real-ip') ?? 'unknown'
  );
}

const MAX_TRACKED_IPS = 10_000;

export function rateLimitMiddleware(): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, WindowEntry>();

  function pruneStale(now: number): void {
    for (const [k, v] of windows) {
      if (now - v.windowStart >= WINDOW_MS) {
        windows.delete(k);
      }
    }
  }

  return async (c, next) => {
    const ip = getClientIp(c.req);
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
