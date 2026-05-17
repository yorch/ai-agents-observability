import type { PrismaClient } from '@ai-agents-observability/db';
import type { PriceTable } from '@ai-agents-observability/schemas';
import { PriceTableSchema } from '@ai-agents-observability/schemas';
import { Hono } from 'hono';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import rawPriceTable from './data/price-table.v1.json' with { type: 'json' };
import { authRequired } from './middleware/auth.js';
import { loggerMiddleware } from './middleware/logger.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { eventsRouter } from './routes/events.js';
import { priceTableRouter } from './routes/price-table.js';
import type { AppEnv, EventsDb } from './types.js';

export type { AppEnv };

export type AppDeps = {
  checkDb: () => Promise<void>;
  checkS3: () => Promise<void>;
  db: Pick<PrismaClient, 'authToken'> & EventsDb;
  logger: Logger;
};

const priceTable: PriceTable = PriceTableSchema.parse(rawPriceTable);

export function createApp(config: Config, deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const startedAt = Date.now();

  app.use('*', requestIdMiddleware());
  app.use('*', loggerMiddleware(deps.logger));

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

  // Public v1 routes — registered before auth middleware so they bypass it
  app.use('/v1/*', rateLimitMiddleware());
  app.route('/v1/price-table', priceTableRouter(priceTable));

  // Auth middleware applies to all remaining /v1/* routes
  app.use('/v1/*', authRequired(deps.db, deps.logger));
  app.route('/v1/events', eventsRouter(deps.db, priceTable, deps.logger));

  return app;
}
