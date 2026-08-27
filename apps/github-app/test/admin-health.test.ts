import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import type { AppDb } from '../src/types';

const stubDb = {} as unknown as AppDb;
const logger = pino({ level: 'silent' });

function makeConfig(adminSecret?: string): Config {
  return {
    admin_secret: adminSecret,
    commit_link_grace_hours: 24,
    database_url: 'postgresql://x',
    git_sha: 'test',
    github_app_id: 1,
    github_app_private_key_b64: '',
    github_app_webhook_secret: 'secret',
    github_host: 'https://github.com',
    jira_project_keys: [],
    log_level: 'error',
    node_env: 'test',
    port: 4001,
    pr_link_lookback_days: 7,
  };
}

describe('GET /admin/health', () => {
  it('is disabled (404) when no admin secret is configured', async () => {
    const app = createApp(makeConfig(undefined), stubDb, logger);
    const res = await app.request('/admin/health');
    expect(res.status).toBe(404);
  });

  it('returns 401 without a matching secret header', async () => {
    const app = createApp(makeConfig('s3cr3t'), stubDb, logger);
    const res = await app.request('/admin/health');
    expect(res.status).toBe(401);
  });

  it('returns metrics when the secret header matches', async () => {
    const app = createApp(makeConfig('s3cr3t'), stubDb, logger);
    const res = await app.request('/admin/health', { headers: { 'x-admin-secret': 's3cr3t' } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deliveries: unknown };
    expect(json).toHaveProperty('deliveries');
  });
});
