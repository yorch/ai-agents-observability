import { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Config } from './config';
import { registry } from './lib/metrics';
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
  app.route('/admin', adminRouter(config.admin_secret));

  // Prometheus metrics — scraped by infra/prometheus
  app.get('/metrics', async (_c) => {
    const output = await registry.metrics();
    return new Response(output, {
      headers: { 'Content-Type': registry.contentType },
    });
  });

  app.route('/webhooks/github', webhooksRouter(db, config, logger));

  // Catch-all for unhandled throws. Without this, Hono returns an opaque 500 with
  // no structured log — and GitHub retries failed webhook deliveries, so the normal
  // failure mode would be silent. Log + 500 so we can see the cause. (Mirrors ingest.)
  app.onError((err, c) => {
    const reqId = c.get('requestId');
    logger.error({ err, reqId }, 'github-app.unhandled_error');
    return c.json({ error: 'Internal server error', request_id: reqId }, 500);
  });

  return app;
}
