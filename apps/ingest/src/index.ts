import { createClient } from '@ai-agents-observability/db';
import { resolveJudgeRevision } from '@ai-agents-observability/schemas';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

import type { AppDeps } from './app';
import { createApp } from './app';
import { loadConfig } from './config';
import { AnthropicBillingSource } from './jobs/anthropic-billing-source';
import { startScheduler } from './jobs/scheduler';
import { AnthropicJudgeClient } from './lib/judge-client';
import { createLogger } from './lib/logger';
import { buildPriceTableRegistry } from './lib/price-tables';

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
        ...(config.jira_value_field ? { valueField: config.jira_value_field } : {}),
      }
    : undefined;

// Vendor-cost source for reconcile-cost — the Anthropic Cost Report client when
// an admin key is configured; otherwise undefined (scheduler falls back to the
// NullBillingSource no-op). Reconciliation still requires BILLING_RECONCILIATION_ENABLED.
const billingSource = config.anthropic_admin_key
  ? new AnthropicBillingSource({
      adminKey: config.anthropic_admin_key,
      baseUrl: config.anthropic_base_url,
      logger,
      ...(config.anthropic_cost_workspace_id
        ? { workspaceId: config.anthropic_cost_workspace_id }
        : {}),
    })
  : undefined;

// LLM-as-judge (P13-009). Wired only when all three of an API key, an operator
// user id, and a *registered* revision for the configured model are present.
// A configured model with no JUDGE_REVISIONS entry is a loud refusal rather
// than a silent fallback: scoring under a borrowed version number is exactly
// the provenance failure the registry exists to prevent.
const judgeRevision = resolveJudgeRevision(config.judge_model);
if (config.judge_anthropic_api_key && config.judge_operator_user_id && !judgeRevision) {
  logger.error(
    { model: config.judge_model },
    'judge: configured model has no registered revision — the judge stays disabled',
  );
}
const judge =
  config.judge_anthropic_api_key && config.judge_operator_user_id && judgeRevision
    ? {
        client: new AnthropicJudgeClient({
          apiKey: config.judge_anthropic_api_key,
          baseUrl: config.anthropic_base_url,
        }),
        config: {
          highCostUsd: config.judge_high_cost_usd,
          maxSessionsPerRun: config.judge_max_sessions_per_run,
          operatorUserId: config.judge_operator_user_id,
          revision: judgeRevision,
          sampleRate: config.judge_sample_rate,
        },
      }
    : undefined;

startScheduler({
  billingReconciliationEnabled: config.billing_reconciliation_enabled,
  bucket: config.s3_bucket,
  db,
  ...(billingSource ? { billingSource } : {}),
  ...(emailConfig ? { emailConfig } : {}),
  ...(config.github_sync_token ? { githubSyncToken: config.github_sync_token } : {}),
  ...(jiraConfig ? { jiraConfig } : {}),
  ...(judge ? { judge } : {}),
  appBaseUrl: config.app_base_url,
  logger,
  orgMaxRetentionDays: config.org_max_retention_days,
  priceTables: buildPriceTableRegistry(),
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
