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

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, starting graceful shutdown');
  server.stop(false);
  const timeout = setTimeout(() => {
    logger.warn('shutdown timeout');
    process.exit(1);
  }, 10_000);
  timeout.unref();
});
