import { createHmac } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
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

const config: Config = {
  commit_link_grace_hours: 24,
  database_url: 'postgresql://x',
  git_sha: 'test',
  github_app_id: 1,
  github_app_private_key_b64: '',
  github_app_webhook_secret: SECRET,
  github_host: 'https://github.com',
  jira_project_keys: [],
  log_level: 'error',
  node_env: 'test',
  port: 4001,
  pr_link_lookback_days: 7,
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

  // The body cap. This route reads the whole body before it can verify the
  // signature — the HMAC is over the body — so an unauthenticated caller chose
  // how much memory it allocated. `apps/ingest` caps both of its authenticated
  // routes; this unauthenticated one capped nothing.
  describe('body limit', () => {
    // Larger than the 25 MB cap, built without allocating a 26 MB string per
    // assertion: `content-length` is what bodyLimit reads first.
    const OVERSIZE = 26 * 1_048_576;

    it('rejects an oversized body with 413', async () => {
      const app = createApp(config, stubDb, logger);
      const res = await app.request('/webhooks/github', {
        body: 'x'.repeat(1024),
        headers: {
          'content-length': String(OVERSIZE),
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-oversize',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=irrelevant',
        },
        method: 'POST',
      });
      expect(res.status).toBe(413);
    });

    it('rejects it BEFORE the signature check, not after', async () => {
      // The discriminating assertion. A valid signature would otherwise be
      // required to reach any rejection at all, and 401-for-bad-signature would
      // look identical to a working cap. This request carries a deliberately
      // wrong signature: if the cap ran after verification the answer would be
      // 401, so 413 proves the limit sits in front — which is the whole point,
      // since verification is what reads the body.
      const app = createApp(config, stubDb, logger);
      const res = await app.request('/webhooks/github', {
        body: '{}',
        headers: {
          'content-length': String(OVERSIZE),
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=definitely-wrong',
        },
        method: 'POST',
      });
      expect(res.status).toBe(413);
    });

    it('still accepts a normal payload', async () => {
      // Positive control: proves the cap is not rejecting everything.
      const body = JSON.stringify({ action: 'opened' });
      const app = createApp(config, stubDb, logger);
      const res = await app.request('/webhooks/github', {
        body,
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-normal',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': sign(body),
        },
        method: 'POST',
      });
      expect(res.status).toBe(202);
    });
  });
});
