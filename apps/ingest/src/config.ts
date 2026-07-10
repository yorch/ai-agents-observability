import { z } from 'zod';

const ConfigSchema = z.object({
  admin_secret: z.string().optional(),
  // Public base URL of the web app, used to build dashboard links in alert
  // notifications (P9-002). Empty by default — links are then relative.
  app_base_url: z.string().default(''),
  // Gates the cost-reconciliation job (P8-006). Off by default — only the
  // NullBillingSource ships, so enabling it without a real source is a no-op.
  billing_reconciliation_enabled: z
    .string()
    .optional()
    .transform((v) => v === 'true')
    .default(false),
  database_url: z.string().min(1),
  git_sha: z.string().default('dev'),
  github_sync_token: z.string().optional(),
  // Jira issue-metadata sync (full P5-004 integration). The sync-jira job runs
  // only when jira_base_url AND jira_api_token are both set. With jira_email
  // set, auth is Basic email:token (Jira Cloud); without it, Bearer PAT
  // (Jira Server/DC).
  jira_api_token: z.string().optional(),
  jira_base_url: z.string().url().optional(),
  jira_email: z.string().optional(),
  // Instance-specific custom field carrying story points (e.g. customfield_10016).
  jira_story_points_field: z.string().optional(),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  node_env: z.enum(['development', 'production', 'test']).default('development'),
  openai_api_key: z.string().optional(),
  // Upper bound for per-team retention overrides (P9-004). A team override above
  // this is clamped, never rejected. Default: 730 (2 years).
  org_max_retention_days: z.coerce.number().int().min(1).default(730),
  port: z.coerce.number().int().min(1).max(65535).default(4000),
  s3_access_key_id: z.string().min(1),
  s3_bucket: z.string().min(1),
  s3_endpoint: z.string().url(),
  s3_force_path_style: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0')
    .default(true),
  s3_region: z.string().default('us-east-1'),
  s3_secret_access_key: z.string().min(1),
  // P7-007 spike. Gates semantic-search prototype. Accepts "1" or "true". No effect on
  // production paths when unset.
  semantic_search_enabled: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true')
    .default(false),
  // SMTP email-alert channel (P9-002 follow-up). All optional: when SMTP_HOST and
  // SMTP_FROM are unset the email channel stays unconfigured and any email alert
  // delivery fails loud (logged in alert_delivery_log) rather than silently.
  smtp_from: z.string().optional(),
  smtp_host: z.string().optional(),
  smtp_password: z.string().optional(),
  smtp_port: z.coerce.number().int().min(1).max(65535).default(587),
  // Implicit TLS (SMTPS, usually port 465). Defaults off — port 587 with STARTTLS
  // is the common path. Accepts "1"/"true".
  smtp_secure: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true')
    .default(false),
  smtp_user: z.string().optional(),
  // Configurable transcript retention (days). Default: 365. Set to 0 to disable.
  transcript_retention_days: z.coerce.number().int().min(0).default(365),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    admin_secret: process.env.ADMIN_SECRET,
    app_base_url: process.env.APP_BASE_URL,
    billing_reconciliation_enabled: process.env.BILLING_RECONCILIATION_ENABLED,
    database_url: process.env.DATABASE_URL,
    git_sha: process.env.GIT_SHA ?? process.env.COMMIT_SHA,
    github_sync_token: process.env.GITHUB_SYNC_TOKEN,
    jira_api_token: process.env.JIRA_API_TOKEN,
    jira_base_url: process.env.JIRA_BASE_URL,
    jira_email: process.env.JIRA_EMAIL,
    jira_story_points_field: process.env.JIRA_STORY_POINTS_FIELD,
    log_level: process.env.LOG_LEVEL,
    node_env: process.env.NODE_ENV,
    openai_api_key: process.env.OPENAI_API_KEY,
    org_max_retention_days: process.env.ORG_MAX_RETENTION_DAYS,
    port: process.env.INGEST_PORT,
    s3_access_key_id: process.env.S3_ACCESS_KEY_ID,
    s3_bucket: process.env.S3_BUCKET,
    s3_endpoint: process.env.S3_ENDPOINT,
    s3_force_path_style: process.env.S3_FORCE_PATH_STYLE,
    s3_region: process.env.S3_REGION,
    s3_secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
    semantic_search_enabled: process.env.SEMANTIC_SEARCH_ENABLED,
    smtp_from: process.env.SMTP_FROM,
    smtp_host: process.env.SMTP_HOST,
    smtp_password: process.env.SMTP_PASSWORD,
    smtp_port: process.env.SMTP_PORT,
    smtp_secure: process.env.SMTP_SECURE,
    smtp_user: process.env.SMTP_USER,
    transcript_retention_days: process.env.TRANSCRIPT_RETENTION_DAYS,
  });
}
