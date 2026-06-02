import { createClient } from '@ai-agents-observability/db';
import pino from 'pino';
import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();

const logger = pino({
  level: config.log_level,
  ...(config.node_env !== 'production' ? { transport: { target: 'pino-pretty' } } : {}),
});

const db = createClient(config.database_url);

const app = createApp(config, db, logger);

const server = Bun.serve({ fetch: app.fetch, port: config.port });

logger.info({ port: config.port, version: config.git_sha }, 'github-app service started');

// Retention: prune webhook_deliveries older than 30 days (P2-009). Daily sweep.
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;
async function pruneWebhookDeliveries(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS);
    const { count } = await db.webhookDelivery.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    if (count > 0) {
      logger.info({ count }, 'webhook.retention.pruned');
    }
  } catch (err) {
    logger.warn({ err }, 'webhook.retention.error');
  }
}
void pruneWebhookDeliveries();
const retentionTimer = setInterval(pruneWebhookDeliveries, DAY_MS);
retentionTimer.unref();

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, starting graceful shutdown');
  server.stop(false);
  const timeout = setTimeout(() => {
    logger.warn('shutdown timeout');
    process.exit(1);
  }, 10_000);
  timeout.unref();
});
