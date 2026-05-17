import type { PrismaClient } from '@ai-agents-observability/db';
import { Hono } from 'hono';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import { authRequired } from './middleware/auth.js';
import { loggerMiddleware } from './middleware/logger.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import type { AppEnv } from './types.js';

export type { AppEnv };

export type AppDeps = {
  checkDb: () => Promise<void>;
  checkS3: () => Promise<void>;
  db: Pick<PrismaClient, 'authToken'>;
  logger: Logger;
};

export function createApp(config: Config, deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const startedAt = Date.now();

  // ── Global middleware ───────────────────────────────────────────────────────
  app.use('*', requestIdMiddleware());
  app.use('*', loggerMiddleware(deps.logger));

  // ── Health / readiness ─────────────────────────────────────────────────────
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      version: config.git_sha,
    }),
  );

  app.get('/readyz', async (c) => {
    const [dbResult, s3Result] = await Promise.allSettled([deps.checkDb(), deps.checkS3()]);

    const ok = dbResult.status === 'fulfilled' && s3Result.status === 'fulfilled';
    return c.json(
      {
        checks: {
          postgres: dbResult.status === 'fulfilled' ? 'ok' : 'error',
          s3: s3Result.status === 'fulfilled' ? 'ok' : 'error',
        },
        ok,
      },
      ok ? 200 : 503,
    );
  });

  // ── Protected API routes ───────────────────────────────────────────────────
  app.use('/v1/*', rateLimitMiddleware());
  app.use('/v1/*', authRequired(deps.db, deps.logger));

  return app;
}
