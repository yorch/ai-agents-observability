import { Hono } from 'hono';
import { getMetrics } from '../lib/metrics';
import type { AppEnv } from '../types';

export function healthRouter(startedAt: number, gitSha: string): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', (c) =>
    c.json({
      ok: true,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      version: gitSha,
    }),
  );

  return router;
}

export function adminRouter(adminSecret: string | undefined): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/health', async (c) => {
    // The admin endpoint exposes delivery counters/event types. It is reachable
    // on the same public listener as the webhook, so it must be gated. When no
    // secret is configured the endpoint is disabled entirely (404) rather than
    // leaking even basic counters; when configured, a matching header is required.
    if (!adminSecret) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (c.req.header('x-admin-secret') !== adminSecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({
      deliveries: await getMetrics(),
      uptime_s: Math.floor(process.uptime()),
    });
  });

  return router;
}
