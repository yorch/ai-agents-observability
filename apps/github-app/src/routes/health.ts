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

  router.get('/health', (c) => {
    const metrics = getMetrics();
    const extended = adminSecret && c.req.header('x-admin-secret') === adminSecret;
    return c.json({
      deliveries: metrics,
      uptime_s: Math.floor(process.uptime()),
      ...(extended ? { extended: true } : {}),
    });
  });

  return router;
}
