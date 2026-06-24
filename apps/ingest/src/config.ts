import { z } from 'zod';

const ConfigSchema = z.object({
  admin_secret: z.string().optional(),
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
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  node_env: z.enum(['development', 'production', 'test']).default('development'),
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
  // Configurable transcript retention (days). Default: 365. Set to 0 to disable.
  transcript_retention_days: z.coerce.number().int().min(0).default(365),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    admin_secret: process.env.ADMIN_SECRET,
    billing_reconciliation_enabled: process.env.BILLING_RECONCILIATION_ENABLED,
    database_url: process.env.DATABASE_URL,
    git_sha: process.env.GIT_SHA ?? process.env.COMMIT_SHA,
    github_sync_token: process.env.GITHUB_SYNC_TOKEN,
    log_level: process.env.LOG_LEVEL,
    node_env: process.env.NODE_ENV,
    org_max_retention_days: process.env.ORG_MAX_RETENTION_DAYS,
    port: process.env.INGEST_PORT,
    s3_access_key_id: process.env.S3_ACCESS_KEY_ID,
    s3_bucket: process.env.S3_BUCKET,
    s3_endpoint: process.env.S3_ENDPOINT,
    s3_force_path_style: process.env.S3_FORCE_PATH_STYLE,
    s3_region: process.env.S3_REGION,
    s3_secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
    transcript_retention_days: process.env.TRANSCRIPT_RETENTION_DAYS,
  });
}
