import { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Config } from './config';
import { loggerMiddleware } from './middleware/logger';
import { requestIdMiddleware } from './middleware/request-id';
import { adminRouter, healthRouter } from './routes/health';
import { webhooksRouter } from './routes/webhooks';
import type { AppDb, AppEnv } from './types';

export function createApp(config: Config, db: AppDb, logger: Logger): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const startedAt = Date.now();

  app.use('*', requestIdMiddleware());
  app.use('*', loggerMiddleware(logger));

  app.route('/health', healthRouter(startedAt, config.git_sha));
  app.route('/admin', adminRouter(process.env.ADMIN_SECRET));
  app.route('/webhooks/github', webhooksRouter(db, config, logger));

  return app;
}
