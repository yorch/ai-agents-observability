import type { PrismaClient } from '@ai-agents-observability/db';
import type { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import type { Logger } from 'pino';

import type { Config } from './config';
import { httpRequestDurationMs, httpRequestsTotal, registry } from './lib/metrics';
import { buildPriceTableRegistry } from './lib/price-tables';
import { authRequired } from './middleware/auth';
import { loggerMiddleware } from './middleware/logger';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { requestIdMiddleware } from './middleware/request-id';
import { adminRouter } from './routes/admin';
import { eventsRouter } from './routes/events';
import { priceTableRouter } from './routes/price-table';
import { transcriptsRouter } from './routes/transcripts';
import type { AppEnv, EventsDb, SessionDb } from './types';

export type { AppEnv };

export type AppDeps = {
  adminSecret?: string;
  checkDb: () => Promise<void>;
  checkS3: () => Promise<void>;
  db: Pick<PrismaClient, 'authToken' | 'jobConfig'> & EventsDb & SessionDb;
  logger: Logger;
  s3: { bucket: string; client: S3Client };
};

const priceTables = buildPriceTableRegistry();

export function createApp(config: Config, deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const startedAt = Date.now();

  app.use('*', requestIdMiddleware());
  app.use('*', loggerMiddleware(deps.logger));

  // Request timing middleware — records HTTP duration + request count for Prometheus
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    const method = c.req.method;
    // Normalise dynamic path segments so cardinality stays bounded.
    // e.g. /v1/events/abc-123 → /v1/events/:id
    const route = c.req.routePath ?? c.req.path;
    const status = String(c.res.status);
    httpRequestsTotal.inc({ method, route, status });
    httpRequestDurationMs.observe({ method, route, status }, durationMs);
  });

  app.get('/health', (c) =>
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

  app.route('/admin', adminRouter(deps.db, config.admin_secret, deps.logger));

  // Prometheus metrics — accessible from Prometheus scraper only (no auth needed in dev)
  app.get('/metrics', async (_c) => {
    const output = await registry.metrics();
    return new Response(output, {
      headers: { 'Content-Type': registry.contentType },
    });
  });

  // Public v1 routes — registered before auth middleware so they bypass it
  app.use('/v1/*', rateLimitMiddleware());
  app.route('/v1/price-table', priceTableRouter(priceTables));

  // Auth middleware applies to all remaining /v1/* routes
  app.use('/v1/*', authRequired(deps.db, deps.logger));
  app.route('/v1/events', eventsRouter(deps.db, priceTables, deps.logger));
  app.route('/v1/transcripts', transcriptsRouter({ db: deps.db, s3: deps.s3 }, deps.logger));

  // Catch-all for unhandled throws (e.g. DB errors on the events hot path).
  // Without this, Hono returns an opaque 500 with no structured log — and ingest
  // clients retry, so the normal failure mode would be silent. Log + 500 so the
  // client backs off and we can see the cause.
  app.onError((err, c) => {
    const reqId = c.get('requestId');
    deps.logger.error({ err, reqId }, 'ingest.unhandled_error');
    return c.json({ error: 'Internal server error', request_id: reqId }, 500);
  });

  return app;
}
