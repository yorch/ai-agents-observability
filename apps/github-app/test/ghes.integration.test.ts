import { createHmac } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { PrUpsertDb } from '../src/lib/pr-upsert';
import { upsertPullRequest } from '../src/lib/pr-upsert';
import type { AppDb } from '../src/types';
import closedMergedFixture from './fixtures/ghes/pull_request.closed.merged.json';
import openedFixture from './fixtures/ghes/pull_request.opened.json';
import synchronizeFixture from './fixtures/ghes/pull_request.synchronize.json';

const stubDb: PrUpsertDb = {
  pullRequest: {
    upsert: vi.fn().mockResolvedValue({}),
  },
  repo: {
    upsert: vi.fn().mockResolvedValue({ id: 'test-repo-id' }),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
};

describe('GHES payload compatibility', () => {
  it('pull_request.opened: upserts PR with correct fields', async () => {
    const pr = openedFixture.pull_request;
    const repo = openedFixture.repository;
    const result = await upsertPullRequest(stubDb, repo, pr, 'OPEN');
    expect(result.repoId).toBe('test-repo-id');
    expect(result.prNumber).toBe(42);
    // html_url domain does not affect the result
    expect(stubDb.repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ githubName: 'backend', githubOwner: 'acme-corp' }),
      }),
    );
  });

  it('pull_request.synchronize: upserts without error', async () => {
    const pr = synchronizeFixture.pull_request;
    const repo = synchronizeFixture.repository;
    const result = await upsertPullRequest(stubDb, repo, pr, 'OPEN');
    expect(result.prNumber).toBe(42);
  });

  it('pull_request.closed (merged): sets merged state and timestamps', async () => {
    const pr = closedMergedFixture.pull_request;
    const repo = closedMergedFixture.repository;
    const result = await upsertPullRequest(stubDb, repo, pr, 'MERGED');
    expect(result.prNumber).toBe(42);
    // Verify merged fields were passed
    const upsertMock = stubDb.pullRequest.upsert as ReturnType<typeof vi.fn>;
    const call = upsertMock.mock.calls.at(-1)?.[0] as {
      create: { mergedAt: unknown; linesAdded: unknown; linesRemoved: unknown; labels: unknown[] };
    };
    expect(call.create.mergedAt).toBeInstanceOf(Date);
    expect(call.create.linesAdded).toBe(120);
    expect(call.create.linesRemoved).toBe(30);
    expect(call.create.labels).toEqual(['enhancement']);
  });

  it('GHES installation=null does not break upsert', async () => {
    const pr = closedMergedFixture.pull_request;
    const repo = closedMergedFixture.repository;
    // installation is null in GHES fixtures — ensure no crash
    await expect(upsertPullRequest(stubDb, repo, pr, 'MERGED')).resolves.toBeDefined();
  });
});

// ── Full-stack signed-POST tests ──────────────────────────────────────────────

const SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

const appConfig = {
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

describe('GHES fixture signed-POST webhooks', () => {
  function makeAppDb(upsertSpy: ReturnType<typeof vi.fn>): AppDb {
    return {
      pRRollup: { findUnique: async () => null, upsert: async () => ({}) },
      pullRequest: { upsert: upsertSpy },
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
  }

  it('pull_request.opened fixture: returns 202 and calls pullRequest.upsert', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({});
    const db = makeAppDb(upsertSpy);
    const app = createApp(appConfig, db, logger);

    const body = JSON.stringify(openedFixture);
    const res = await app.request('/webhooks/github', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'ghes-opened-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(body),
      },
      method: 'POST',
    });

    expect(res.status).toBe(202);
    expect(upsertSpy).toHaveBeenCalled();
  });

  it('pull_request.closed.merged fixture: returns 202 and calls pullRequest.upsert', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({});
    const db = makeAppDb(upsertSpy);
    const app = createApp(appConfig, db, logger);

    const body = JSON.stringify(closedMergedFixture);
    const res = await app.request('/webhooks/github', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'ghes-closed-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(body),
      },
      method: 'POST',
    });

    expect(res.status).toBe(202);
    expect(upsertSpy).toHaveBeenCalled();
  });
});
