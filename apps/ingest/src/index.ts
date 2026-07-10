import { createClient } from '@ai-agents-observability/db';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

import type { AppDeps } from './app';
import { createApp } from './app';
import { loadConfig } from './config';
import { startScheduler } from './jobs/scheduler';
import { createLogger } from './lib/logger';

const config = loadConfig();

const logger = createLogger(config);

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

// Only wire the email channel when an SMTP host + sender are configured; otherwise
// leave it undefined so email-alert delivery fails loud (logged) rather than silent.
const emailConfig =
  config.smtp_host && config.smtp_from
    ? {
        from: config.smtp_from,
        host: config.smtp_host,
        ...(config.smtp_password ? { password: config.smtp_password } : {}),
        port: config.smtp_port,
        secure: config.smtp_secure,
        ...(config.smtp_user ? { user: config.smtp_user } : {}),
      }
    : undefined;

// Jira issue-metadata sync runs only when both the base URL and an API token
// are configured (JIRA_BASE_URL + JIRA_API_TOKEN).
const jiraConfig =
  config.jira_base_url && config.jira_api_token
    ? {
        apiToken: config.jira_api_token,
        baseUrl: config.jira_base_url,
        ...(config.jira_email ? { email: config.jira_email } : {}),
        ...(config.jira_epic_link_field ? { epicLinkField: config.jira_epic_link_field } : {}),
        ...(config.jira_story_points_field
          ? { storyPointsField: config.jira_story_points_field }
          : {}),
      }
    : undefined;

startScheduler({
  billingReconciliationEnabled: config.billing_reconciliation_enabled,
  bucket: config.s3_bucket,
  db,
  ...(emailConfig ? { emailConfig } : {}),
  ...(config.github_sync_token ? { githubSyncToken: config.github_sync_token } : {}),
  ...(jiraConfig ? { jiraConfig } : {}),
  appBaseUrl: config.app_base_url,
  logger,
  orgMaxRetentionDays: config.org_max_retention_days,
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
