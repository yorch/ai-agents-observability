import { z } from 'zod';

const ConfigSchema = z.object({
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
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    database_url: process.env.DATABASE_URL,
    git_sha: process.env.GIT_SHA ?? process.env.COMMIT_SHA,
    github_app_id: process.env.GITHUB_APP_ID,
    github_app_private_key_b64: process.env.GITHUB_APP_PRIVATE_KEY,
    github_app_webhook_secret: process.env.GITHUB_APP_WEBHOOK_SECRET,
    github_host: process.env.GITHUB_HOST,
    log_level: process.env.LOG_LEVEL,
    node_env: process.env.NODE_ENV,
    port: process.env.GITHUB_APP_PORT,
  });
}
