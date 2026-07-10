import { z } from 'zod';

const WebConfigSchema = z.object({
  githubAllowedOrg: z.string().optional(),
  githubHost: z.string().default('github.com'),
  githubOAuthClientId: z.string().optional(),
  githubOAuthClientSecret: z.string().optional(),
  ingestUrl: z.string().url().optional(),
  jiraBaseUrl: z.string().optional(),
  s3AccessKeyId: z.string().min(1),
  s3Bucket: z.string().min(1),
  s3Endpoint: z.string().optional(),
  s3Region: z.string().default('us-east-1'),
  s3SecretAccessKey: z.string().min(1),
});

export type WebConfig = z.infer<typeof WebConfigSchema>;

let _config: WebConfig | null = null;

// Lazy singleton — only touches process.env on first call, so Next.js
// build-time static analysis can import modules cleanly.
export function getConfig(): WebConfig {
  if (!_config) {
    _config = WebConfigSchema.parse({
      githubAllowedOrg: process.env.GITHUB_ALLOWED_ORG,
      githubHost: process.env.GITHUB_HOST,
      githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      ingestUrl: process.env.INGEST_URL,
      jiraBaseUrl: process.env.NEXT_PUBLIC_JIRA_BASE_URL,
      s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
      s3Bucket: process.env.S3_BUCKET,
      s3Endpoint: process.env.S3_ENDPOINT,
      s3Region: process.env.S3_REGION,
      s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
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
