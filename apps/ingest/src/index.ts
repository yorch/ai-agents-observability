import { createClient } from '@ai-agents-observability/db';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import pino from 'pino';

import type { AppDeps } from './app';
import { createApp } from './app';
import { loadConfig } from './config';
import { startScheduler } from './jobs/scheduler';

const config = loadConfig();

const logger = pino({
  level: config.log_level,
  ...(config.node_env !== 'production' ? { transport: { target: 'pino-pretty' } } : {}),
});

const db = createClient(config.database_url);

const s3 = new S3Client({
  credentials: {
    accessKeyId: config.s3_access_key_id,
    secretAccessKey: config.s3_secret_access_key,
  },
  endpoint: config.s3_endpoint,
  forcePathStyle: config.s3_force_path_style,
  region: config.s3_region,
});

const deps: AppDeps = {
  ...(config.admin_secret ? { adminSecret: config.admin_secret } : {}),
  checkDb: async () => {
    await db.$queryRaw`SELECT 1`;
  },
  checkS3: async () => {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3_bucket }));
  },
  db,
  logger,
  s3: { bucket: config.s3_bucket, client: s3 },
};

const app = createApp(config, deps);

const server = Bun.serve({
  fetch: app.fetch,
  port: config.port,
});

logger.info({ port: config.port, version: config.git_sha }, 'ingest service started');

startScheduler({
  billingReconciliationEnabled: config.billing_reconciliation_enabled,
  bucket: config.s3_bucket,
  db,
  ...(config.github_sync_token ? { githubSyncToken: config.github_sync_token } : {}),
  logger,
  s3,
  transcriptRetentionDays: config.transcript_retention_days,
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, starting graceful shutdown');

  server.stop(false);

  const timeout = setTimeout(() => {
    logger.warn('graceful shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10_000);

  timeout.unref();
});
