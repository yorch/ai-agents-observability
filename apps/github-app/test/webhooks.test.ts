import { createHmac } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppDb } from '../src/types';

const SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

// Minimal stub db that satisfies AppDb without a real Postgres connection
const stubDb = {
  pRRollup: { findUnique: async () => null, upsert: async () => ({}) },
  pullRequest: { upsert: async () => ({}) },
  repo: { upsert: async () => ({ id: 'repo-id' }) },
  session: { findMany: async () => [] },
  sessionPRLink: { createMany: async () => ({}), findMany: async () => [] },
  user: { findUnique: async () => null },
  webhookDelivery: {
    create: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
    update: async () => ({}),
  },
} as unknown as AppDb;

const config = {
  database_url: 'postgresql://x',
  git_sha: 'test',
  github_app_id: 1,
  github_app_private_key_b64: '',
  github_app_webhook_secret: SECRET,
  github_host: 'https://github.com',
  log_level: 'silent' as const,
  node_env: 'test' as const,
  port: 4001,
};

const logger = pino({ level: 'silent' });

describe('webhooks', () => {
  it('returns 401 for missing signature', async () => {
    const app = createApp(config, stubDb, logger);
    const res = await app.request('/webhooks/github', {
      body: '{}',
      headers: { 'x-github-event': 'ping' },
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong signature', async () => {
    const app = createApp(config, stubDb, logger);
    const res = await app.request('/webhooks/github', {
      body: '{}',
      headers: {
        'x-github-delivery': 'test-id',
        'x-github-event': 'ping',
        'x-hub-signature-256': 'sha256=badhash',
      },
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing event header', async () => {
    const body = '{}';
    const app = createApp(config, stubDb, logger);
    const res = await app.request('/webhooks/github', {
      body,
      headers: {
        'x-github-delivery': 'test-id',
        'x-hub-signature-256': sign(body),
      },
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('returns 202 for valid unknown event', async () => {
    const body = JSON.stringify({ action: 'test' });
    const app = createApp(config, stubDb, logger);
    const res = await app.request('/webhooks/github', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'test-id',
        'x-github-event': 'unknown_event',
        'x-hub-signature-256': sign(body),
      },
      method: 'POST',
    });
    expect(res.status).toBe(202);
  });

  it('persists each delivery keyed by the delivery id', async () => {
    const created: string[] = [];
    const db = {
      ...stubDb,
      webhookDelivery: {
        ...(stubDb as unknown as { webhookDelivery: object }).webhookDelivery,
        create: async ({ data }: { data: { deliveryId: string } }) => {
          created.push(data.deliveryId);
          return {};
        },
      },
    } as unknown as AppDb;
    const body = JSON.stringify({ action: 'opened' });
    const app = createApp(config, db, logger);
    await app.request('/webhooks/github', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-123',
        'x-github-event': 'unknown_event',
        'x-hub-signature-256': sign(body),
      },
      method: 'POST',
    });
    expect(created).toContain('delivery-123');
  });

  it('returns 503 (so GitHub retries) when the delivery cannot be persisted', async () => {
    const db = {
      ...stubDb,
      webhookDelivery: {
        ...(stubDb as unknown as { webhookDelivery: object }).webhookDelivery,
        create: async () => {
          // Non-P2002 failure (e.g. DB down) — must NOT process without a record.
          throw new Error('connection refused');
        },
      },
    } as unknown as AppDb;
    const body = JSON.stringify({ action: 'opened' });
    const app = createApp(config, db, logger);
    const res = await app.request('/webhooks/github', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-503',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(body),
      },
      method: 'POST',
    });
    expect(res.status).toBe(503);
  });

  it('treats a replayed delivery id as a duplicate (no reprocessing)', async () => {
    const db = {
      ...stubDb,
      webhookDelivery: {
        ...(stubDb as unknown as { webhookDelivery: object }).webhookDelivery,
        create: async () => {
          throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
        },
      },
    } as unknown as AppDb;
    const body = JSON.stringify({ action: 'opened' });
    const app = createApp(config, db, logger);
    const res = await app.request('/webhooks/github', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-123',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(body),
      },
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { duplicate?: boolean };
    expect(json.duplicate).toBe(true);
  });
});
