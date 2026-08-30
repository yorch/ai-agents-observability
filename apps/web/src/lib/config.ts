import { z } from 'zod';

const WebConfigSchema = z.object({
  // The browser-facing origin. OAuth cannot infer this reliably from a request
  // after a reverse proxy has forwarded it to the container.
  appBaseUrl: z.url().optional(),
  githubAllowedOrg: z.string().optional(),
  githubHost: z.string().default('https://github.com'),
  githubOAuthClientId: z.string().optional(),
  githubOAuthClientSecret: z.string().optional(),
  // Hook token TTL in days. Default: 365 (when unset or 0). Must be a positive
  // integer. Set to a shorter value to enforce more frequent token rotation.
  hookTokenTtlDays: z.coerce.number().int().min(1).max(3650).optional(),
  ingestUrl: z.string().url().optional(),
  isProduction: z.boolean(),
  jiraBaseUrl: z.string().optional(),
  s3AccessKeyId: z.string().min(1),
  s3Bucket: z.string().min(1),
  s3Endpoint: z.string().optional(),
  s3Region: z.string().default('us-east-1'),
  s3SecretAccessKey: z.string().min(1),
  // Number of trusted reverse proxies in front of the web app. When set,
  // clientIp() takes the Nth-from-right entry from X-Forwarded-For. When
  // unset, XFF is ignored and the first hop is not trusted.
  trustedProxyCount: z.coerce.number().int().min(0).optional(),
  // Org-wide business value of one delivered Jira story point, in USD. When set
  // (> 0), /org/roi shows value-delivered vs agent-spend. Optional: the whole
  // business-value section is hidden when unset. `.catch` keeps a malformed value
  // from failing web startup — it just disables the section.
  valuePerStoryPoint: z.coerce.number().nonnegative().optional().catch(undefined),
});

export type WebConfig = z.infer<typeof WebConfigSchema>;

let _config: WebConfig | null = null;

// Lazy singleton — only touches process.env on first call, so Next.js
// build-time static analysis can import modules cleanly.
export function getConfig(): WebConfig {
  if (!_config) {
    _config = WebConfigSchema.parse({
      appBaseUrl: process.env.APP_BASE_URL,
      githubAllowedOrg: process.env.GITHUB_ALLOWED_ORG,
      githubHost: process.env.GITHUB_HOST,
      githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      hookTokenTtlDays: process.env.HOOK_TOKEN_TTL_DAYS,
      ingestUrl: process.env.INGEST_URL,
      isProduction: process.env.NODE_ENV === 'production',
      jiraBaseUrl: process.env.NEXT_PUBLIC_JIRA_BASE_URL,
      s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
      s3Bucket: process.env.S3_BUCKET,
      s3Endpoint: process.env.S3_ENDPOINT,
      s3Region: process.env.S3_REGION,
      s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      trustedProxyCount: process.env.TRUSTED_PROXY_COUNT,
      valuePerStoryPoint: process.env.VALUE_PER_STORY_POINT,
    });
  }
  return _config;
}

/**
 * Jira browse base URL, normalized (no trailing slash), or null when Jira
 * links are not configured. Use this instead of reading jiraBaseUrl directly
 * so every page builds `${base}/browse/${key}` links identically.
 */
export function getJiraBase(): string | null {
  return getConfig().jiraBaseUrl?.replace(/\/$/, '') ?? null;
}
