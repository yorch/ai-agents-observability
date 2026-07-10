import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getJiraProjectAllowlist, resetJiraProjectAllowlistCache } from './jira-projects';

type MockDb = Parameters<typeof getJiraProjectAllowlist>[0];

function makeDb(projectKeys: string[]) {
  return {
    jiraIssue: {
      findMany: vi.fn().mockResolvedValue(projectKeys.map((projectKey) => ({ projectKey }))),
    },
  } as unknown as MockDb & { jiraIssue: { findMany: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
  resetJiraProjectAllowlistCache();
});

describe('getJiraProjectAllowlist', () => {
  it('unions configured keys with synced project keys, uppercased', async () => {
    const db = makeDb(['OBS']);

    const allowlist = await getJiraProjectAllowlist(db, ['plat', ' CORE ']);

    expect(allowlist).toEqual(new Set(['CORE', 'OBS', 'PLAT']));
  });

  it('returns null (accept-all bootstrap mode) when no keys are known', async () => {
    const db = makeDb([]);

    expect(await getJiraProjectAllowlist(db, [])).toBeNull();
  });

  it('caches synced keys between calls', async () => {
    const db = makeDb(['OBS']);

    await getJiraProjectAllowlist(db, []);
    await getJiraProjectAllowlist(db, []);

    expect(db.jiraIssue.findMany).toHaveBeenCalledTimes(1);
  });

  it('degrades to configured keys when the DB query fails', async () => {
    const db = {
      jiraIssue: { findMany: vi.fn().mockRejectedValue(new Error('db down')) },
    } as unknown as MockDb;

    expect(await getJiraProjectAllowlist(db, ['OBS'])).toEqual(new Set(['OBS']));
    expect(await getJiraProjectAllowlist(db, [])).toBeNull();
  });
});
