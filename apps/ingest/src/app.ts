import type { PrismaClient } from '@ai-agents-observability/db';
import type { PriceTable } from '@ai-agents-observability/schemas';
import { PriceTableSchema } from '@ai-agents-observability/schemas';
import type { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import type { Logger } from 'pino';

import type { Config } from './config';
import rawPriceTable from './data/price-table.v1.json' with { type: 'json' };
import { authRequired } from './middleware/auth';
import { loggerMiddleware } from './middleware/logger';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { requestIdMiddleware } from './middleware/request-id';
import { eventsRouter } from './routes/events';
import { priceTableRouter } from './routes/price-table';
import { transcriptsRouter } from './routes/transcripts';
import type { AppEnv, EventsDb, SessionDb } from './types';

export type { AppEnv };

export type AppDeps = {
  checkDb: () => Promise<void>;
  checkS3: () => Promise<void>;
  db: Pick<PrismaClient, 'authToken'> & EventsDb & SessionDb;
  logger: Logger;
  s3: { bucket: string; client: S3Client };
};

const priceTable: PriceTable = PriceTableSchema.parse(rawPriceTable);

export function createApp(config: Config, deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const startedAt = Date.now();

  app.use('*', requestIdMiddleware());
  app.use('*', loggerMiddleware(deps.logger));

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

  // Public v1 routes — registered before auth middleware so they bypass it
  app.use('/v1/*', rateLimitMiddleware());
  app.route('/v1/price-table', priceTableRouter(priceTable));

  // Auth middleware applies to all remaining /v1/* routes
  app.use('/v1/*', authRequired(deps.db, deps.logger));
  app.route('/v1/events', eventsRouter(deps.db, priceTable, deps.logger));
  app.route('/v1/transcripts', transcriptsRouter({ db: deps.db, s3: deps.s3 }, deps.logger));

  return app;
}
