import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSyncJira, type SyncJiraDb } from '../src/jobs/sync-jira';

const CONFIG = {
  apiToken: 'tok',
  baseUrl: 'https://jira.example.com',
  email: 'svc@example.com',
  storyPointsField: 'customfield_10016',
};

function makeDb({ prKeys = ['OBS-1'], sessionKeys = ['OBS-2'], freshKeys = [] as string[] } = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ pg_try_advisory_lock: true }]),
    jiraIssue: {
      findMany: vi.fn().mockResolvedValue(freshKeys.map((key) => ({ key }))),
      upsert: vi.fn().mockResolvedValue({}),
    },
    jobRun: {
      create: vi.fn().mockResolvedValue({ id: 1n }),
      update: vi.fn().mockResolvedValue({}),
    },
    pullRequest: {
      findMany: vi.fn().mockResolvedValue(prKeys.map((jiraKey) => ({ jiraKey }))),
    },
    session: {
      findMany: vi.fn().mockResolvedValue(sessionKeys.map((jiraKey) => ({ jiraKey }))),
    },
  } as unknown as SyncJiraDb & {
    jiraIssue: { findMany: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    jobRun: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  };
}

function issueResponse(fields: Record<string, unknown>) {
  return {
    json: () => Promise.resolve({ fields }),
    ok: true,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runSyncJira', () => {
  it('syncs every key referenced by PRs and sessions into jira_issues', async () => {
    const db = makeDb();
    const fetchMock = vi.fn().mockResolvedValue(
      issueResponse({
        assignee: { displayName: 'Jorge' },
        customfield_10016: 5,
        issuetype: { name: 'Story' },
        parent: { key: 'OBS-100' },
        resolutiondate: '2026-01-05T00:00:00Z',
        status: { name: 'Done' },
        summary: 'Do the thing',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runSyncJira(db, CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(2); // OBS-1 + OBS-2
    // Jira Cloud auth: Basic email:token.
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe(
      `Basic ${Buffer.from('svc@example.com:tok').toString('base64')}`,
    );
    expect(db.jiraIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          assignee: 'Jorge',
          epicKey: 'OBS-100',
          issueType: 'Story',
          key: 'OBS-1',
          resolvedAt: new Date('2026-01-05T00:00:00Z'),
          status: 'Done',
          storyPoints: 5,
          summary: 'Do the thing',
        }),
        where: { key: 'OBS-1' },
      }),
    );
    expect(db.jobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'success' }) }),
    );
  });

  it('skips keys with a fresh snapshot', async () => {
    const db = makeDb({ freshKeys: ['OBS-1', 'OBS-2'] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await runSyncJira(db, CONFIG);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.jiraIssue.upsert).not.toHaveBeenCalled();
  });

  it('counts 404s without creating rows', async () => {
    const db = makeDb({ prKeys: ['NOPE-1'], sessionKeys: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response));

    await runSyncJira(db, CONFIG);

    expect(db.jiraIssue.upsert).not.toHaveBeenCalled();
    expect(db.jobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'success' }) }),
    );
  });

  it('uses Bearer auth when no email is configured (Jira Server/DC PAT)', async () => {
    const db = makeDb({ prKeys: ['OBS-1'], sessionKeys: [] });
    const fetchMock = vi.fn().mockResolvedValue(issueResponse({ summary: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    await runSyncJira(db, { apiToken: 'pat', baseUrl: 'https://jira.example.com' });

    expect(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer pat');
  });

  it('falls back to the Epic Link custom field when parent is absent (classic projects)', async () => {
    const db = makeDb({ prKeys: ['OBS-1'], sessionKeys: [] });
    const fetchMock = vi.fn().mockResolvedValue(
      issueResponse({
        customfield_10014: 'OBS-500',
        summary: 'classic project issue',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runSyncJira(db, { ...CONFIG, epicLinkField: 'customfield_10014' });

    expect(db.jiraIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ epicKey: 'OBS-500' }),
      }),
    );
  });
});
