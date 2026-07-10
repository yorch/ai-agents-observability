import { z } from 'zod';

// GITHUB_HOST is shared (via .env) with apps/web, which uses a BARE host
// ("github.com"). This service needs a full origin to derive the API base, so
// normalize: prepend https:// if no scheme is present. Without this, a shared
// `.env` setting GITHUB_HOST=github.com would fail this service's URL validation
// and prevent it from booting.
export function normalizeHost(raw: string | undefined): string | undefined {
  if (!raw) {
    return raw;
  }
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

const ConfigSchema = z.object({
  // When set, GET /admin/health requires a matching X-Admin-Secret header.
  // When unset, the admin endpoint is disabled (404) rather than leaking counters.
  admin_secret: z.string().min(1).optional(),
  // Commit→session correlation window: a default-branch commit is attributed to
  // a session when it lands within the session's activity window extended by
  // this many hours (devs routinely commit shortly after the session ends).
  commit_link_grace_hours: z.coerce.number().int().min(0).default(24),
  database_url: z.string().min(1),
  git_sha: z.string().default('dev'),
  github_app_id: z.coerce.number().int().positive(),
  // base64-encoded PEM private key
  github_app_private_key_b64: z.string().min(1),
  github_app_webhook_secret: z.string().min(1),
  github_host: z.string().url().default('https://github.com'),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  node_env: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(4001),
  // Session↔PR backfill window: sessions starting up to this many days before
  // the PR opened are link candidates (P2-004 hardening).
  pr_link_lookback_days: z.coerce.number().int().min(1).default(7),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    admin_secret: process.env.ADMIN_SECRET,
    commit_link_grace_hours: process.env.COMMIT_LINK_GRACE_HOURS,
    database_url: process.env.DATABASE_URL,
    git_sha: process.env.GIT_SHA ?? process.env.COMMIT_SHA,
    github_app_id: process.env.GITHUB_APP_ID,
    github_app_private_key_b64: process.env.GITHUB_APP_PRIVATE_KEY,
    github_app_webhook_secret: process.env.GITHUB_APP_WEBHOOK_SECRET,
    github_host: normalizeHost(process.env.GITHUB_HOST),
    log_level: process.env.LOG_LEVEL,
    node_env: process.env.NODE_ENV,
    port: process.env.GITHUB_APP_PORT,
    pr_link_lookback_days: process.env.PR_LINK_LOOKBACK_DAYS,
  });
}
