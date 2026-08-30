import { commaSeparatedList } from '@ai-agents-observability/schemas';
import { z } from 'zod';

const ConfigSchema = z.object({
  admin_secret: z.string().optional(),
  // Anthropic Admin API key (`sk-ant-admin...`) for the cost-reconciliation
  // job's vendor-cost source (Cost Report API). When set (and billing
  // reconciliation is enabled), reconcile-cost compares client-computed cost
  // against Anthropic's billed cost; unset → NullBillingSource (no comparison).
  anthropic_admin_key: z.string().optional(),
  // Base URL for the Anthropic API (override for testing / gov endpoints).
  anthropic_base_url: z.string().url().default('https://api.anthropic.com'),
  // Optional: restrict the Cost Report to a single workspace (a dedicated
  // Claude Code workspace). Unset → the org's total Anthropic spend.
  anthropic_cost_workspace_id: z.string().optional(),
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
  // ── GitHub AI-credit billing source for reconcile-cost (P14-017) ──────────
  // Wired only when github_billing_token AND github_billing_scope are both set,
  // mirroring the Anthropic path: absent config leaves NullBillingSource alone.
  // Optional `product` filter — unset means every AI-credit product on the
  // account, which over-counts against our CLI-only event stream. GHES host
  // override; unset → github.com (or the shared client's GITHUB_HOST default).
  github_billing_host: z.string().url().optional(),
  github_billing_product: z.string().optional(),
  // Organization login, enterprise slug, or username — matching the scope kind.
  github_billing_scope: z.string().optional(),
  github_billing_scope_kind: z.enum(['organization', 'enterprise', 'user']).default('organization'),
  // Classic PAT with billing read access. GitHub's billing usage endpoints do
  // not accept fine-grained PATs; only the enterprise scope also takes a
  // GitHub App token. Deliberately separate from GITHUB_SYNC_TOKEN — team sync
  // needs org:read, this needs the bill, and one credential doing both is a
  // blast radius nobody chose.
  github_billing_token: z.string().optional(),
  github_sync_token: z.string().optional(),
  // Jira issue-metadata sync (full P5-004 integration). The sync-jira job runs
  // only when jira_base_url AND jira_api_token are both set. With jira_email
  // set, auth is Basic email:token (Jira Cloud); without it, Bearer PAT
  // (Jira Server/DC).
  jira_api_token: z.string().optional(),
  jira_base_url: z.string().url().optional(),
  jira_email: z.string().optional(),
  // Classic-project "Epic Link" custom field (e.g. customfield_10014); modern
  // projects use `parent` and don't need this.
  jira_epic_link_field: z.string().optional(),
  // Comma-separated Jira project codes (e.g. "PLAT,OBS") that key extraction
  // accepts, unioned with project keys learned by sync-jira. When both are
  // empty, extraction accepts any key-shaped token (bootstrap mode).
  jira_project_keys: commaSeparatedList,
  // Instance-specific custom field carrying story points (e.g. customfield_10016).
  jira_story_points_field: z.string().optional(),
  // Optional Jira custom field holding a per-issue business value (currency
  // units), e.g. "customfield_10032". Synced into jira_issues.business_value.
  jira_value_field: z.string().optional(),
  // ── LLM-as-judge (P13-009) ────────────────────────────────────────────────
  // The judge is an optional subsystem gated by *config presence*, not a flag:
  // with no API key and no operator user id it never runs, and its scheduled
  // entry no-ops with a warning. Both are required — the operator id is the
  // second guard (own-sessions-only), not a convenience.
  //
  // Anthropic API key for the judge. Deliberately separate from
  // ANTHROPIC_ADMIN_KEY (cost reconciliation): a judge key spends money and an
  // admin key reads the bill, and one credential doing both is a blast radius
  // nobody chose.
  judge_anthropic_api_key: z.string().optional(),
  // A session at or above this cost that ended abandoned is always judged,
  // regardless of the sample rate — expensive abandonment is the
  // outcome-negative case a sample would most likely miss.
  judge_high_cost_usd: z.coerce.number().min(0).default(5),
  // Per-run cap. Bounds spend and runtime for one nightly pass; the next run
  // picks up what this one left, because scoring is idempotent per version.
  judge_max_sessions_per_run: z.coerce.number().int().min(1).max(500).default(25),
  // Judge model. Must have a JUDGE_REVISIONS entry in packages/schemas — an
  // unregistered model is refused rather than scored at a borrowed version.
  judge_model: z.string().default('claude-opus-5'),
  // The operator whose own sessions the judge may read. Until P13-011 this is
  // the only user whose transcripts the runner can touch, and it is also the
  // actor recorded on every audit row the judge writes.
  judge_operator_user_id: z.uuid().optional(),
  // Share of eligible sessions sampled, in [0, 1]. Default 10% — the low end of
  // the 5–20% the literature converges on. Outcome-negative sessions bypass it.
  judge_sample_rate: z.coerce.number().min(0).max(1).default(0.1),
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
  // KMS key ID/ARN when s3_sse_algorithm is 'aws:kms'. Ignored otherwise.
  s3_kms_key_id: z.string().optional(),
  s3_region: z.string().default('us-east-1'),
  s3_secret_access_key: z.string().min(1),
  // Optional server-side encryption for S3 transcript objects. Set to 'AES256'
  // for SSE-S3 or 'aws:kms' for SSE-KMS. When unset, no SSE headers are sent
  // (preserving current behavior for MinIO which doesn't support SSE headers).
  s3_sse_algorithm: z.string().optional(),
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
  // Number of trusted reverse proxies in front of ingest. When set, the
  // rate limiter takes the Nth-from-right entry from X-Forwarded-For (the
  // real client IP). When unset, XFF is ignored and the socket remote
  // address is used. 0 means "no trusted proxies" (same as unset for XFF).
  trusted_proxy_count: z.coerce.number().int().min(0).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    admin_secret: process.env.ADMIN_SECRET,
    anthropic_admin_key: process.env.ANTHROPIC_ADMIN_KEY,
    anthropic_base_url: process.env.ANTHROPIC_BASE_URL,
    anthropic_cost_workspace_id: process.env.ANTHROPIC_COST_WORKSPACE_ID,
    app_base_url: process.env.APP_BASE_URL,
    billing_reconciliation_enabled: process.env.BILLING_RECONCILIATION_ENABLED,
    database_url: process.env.DATABASE_URL,
    git_sha: process.env.GIT_SHA ?? process.env.COMMIT_SHA,
    github_billing_host: process.env.GITHUB_BILLING_HOST,
    github_billing_product: process.env.GITHUB_BILLING_PRODUCT,
    github_billing_scope: process.env.GITHUB_BILLING_SCOPE,
    github_billing_scope_kind: process.env.GITHUB_BILLING_SCOPE_KIND,
    github_billing_token: process.env.GITHUB_BILLING_TOKEN,
    github_sync_token: process.env.GITHUB_SYNC_TOKEN,
    jira_api_token: process.env.JIRA_API_TOKEN,
    jira_base_url: process.env.JIRA_BASE_URL,
    jira_email: process.env.JIRA_EMAIL,
    jira_epic_link_field: process.env.JIRA_EPIC_LINK_FIELD,
    jira_project_keys: process.env.JIRA_PROJECT_KEYS,
    jira_story_points_field: process.env.JIRA_STORY_POINTS_FIELD,
    jira_value_field: process.env.JIRA_VALUE_FIELD,
    judge_anthropic_api_key: process.env.JUDGE_ANTHROPIC_API_KEY,
    judge_high_cost_usd: process.env.JUDGE_HIGH_COST_USD,
    judge_max_sessions_per_run: process.env.JUDGE_MAX_SESSIONS_PER_RUN,
    judge_model: process.env.JUDGE_MODEL,
    judge_operator_user_id: process.env.JUDGE_OPERATOR_USER_ID,
    judge_sample_rate: process.env.JUDGE_SAMPLE_RATE,
    log_level: process.env.LOG_LEVEL,
    node_env: process.env.NODE_ENV,
    openai_api_key: process.env.OPENAI_API_KEY,
    org_max_retention_days: process.env.ORG_MAX_RETENTION_DAYS,
    port: process.env.INGEST_PORT,
    s3_access_key_id: process.env.S3_ACCESS_KEY_ID,
    s3_bucket: process.env.S3_BUCKET,
    s3_endpoint: process.env.S3_ENDPOINT,
    s3_force_path_style: process.env.S3_FORCE_PATH_STYLE,
    s3_kms_key_id: process.env.S3_KMS_KEY_ID,
    s3_region: process.env.S3_REGION,
    s3_secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
    s3_sse_algorithm: process.env.S3_SSE_ALGORITHM,
    semantic_search_enabled: process.env.SEMANTIC_SEARCH_ENABLED,
    smtp_from: process.env.SMTP_FROM,
    smtp_host: process.env.SMTP_HOST,
    smtp_password: process.env.SMTP_PASSWORD,
    smtp_port: process.env.SMTP_PORT,
    smtp_secure: process.env.SMTP_SECURE,
    smtp_user: process.env.SMTP_USER,
    transcript_retention_days: process.env.TRANSCRIPT_RETENTION_DAYS,
    trusted_proxy_count: process.env.TRUSTED_PROXY_COUNT,
  });
}
