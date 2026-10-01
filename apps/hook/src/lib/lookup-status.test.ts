import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { fetchOpenPrNumber, fetchPrSnapshot } from './github-pr';
import { fetchGitHubLogin, fetchUserTeam } from './github-user';
import { lookupFailures, resetLookupFailures } from './lookup-status';

// Enrichment is stored with the queue row, so it has to tell "gh answered: there is
// no PR" (final) from "gh could not be asked" (open: try again later). The resolvers
// return null for both; these pin that they record the difference.

type Spawn = typeof Bun.spawnSync;

/** A spawn stub that behaves like `gh` exiting `exitCode` with `stdout`. */
const gh = (exitCode: number, stdout = ''): Spawn =>
  (() => ({ exitCode, stderr: Buffer.alloc(0), stdout: Buffer.from(stdout) })) as unknown as Spawn;

const throwing: Spawn = (() => {
  throw new Error('spawn gh ENOENT');
}) as unknown as Spawn;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  // No REST fallback: these are about gh.
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetLookupFailures();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

describe('PR lookup', () => {
  it('"gh answered: no open PR" is an answer, not a failure', async () => {
    expect(await fetchOpenPrNumber('acme', 'widgets', 'feature/x', null, gh(0, '[]'))).toBeNull();
    expect(lookupFailures()).toBe(0);
  });

  it('a PR that is found is an answer', async () => {
    expect(
      await fetchOpenPrNumber('acme', 'widgets', 'feature/x', null, gh(0, '[{"number":42}]')),
    ).toBe(42);
    expect(lookupFailures()).toBe(0);
  });

  it('"gh could not be asked" (non-zero exit) is a failure, not "no PR"', async () => {
    expect(await fetchOpenPrNumber('acme', 'widgets', 'feature/x', null, gh(1))).toBeNull();
    expect(lookupFailures()).toBe(1);
  });

  it('gh missing entirely (the spawn throws) is a failure too', async () => {
    expect(await fetchOpenPrNumber('acme', 'widgets', 'feature/x', null, throwing)).toBeNull();
    expect(lookupFailures()).toBe(1);
  });

  it('gh failing but the REST fallback answering is an answer', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch;
    try {
      expect(
        await fetchOpenPrNumber(
          'acme',
          'widgets',
          'feature/x',
          'https://github.com/acme/widgets.git',
          gh(1),
        ),
      ).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(lookupFailures()).toBe(0);
  });
});

describe('snapshot, login and team lookups', () => {
  it('record a failure when gh cannot be asked, and none when it answers', () => {
    expect(fetchPrSnapshot('acme', 'widgets', 7, gh(1))).toBeNull();
    expect(fetchGitHubLogin(gh(1))).toBeNull();
    expect(fetchUserTeam('acme', gh(1))).toBeNull();
    expect(lookupFailures()).toBe(3);

    resetLookupFailures();
    expect(fetchGitHubLogin(gh(0, 'octocat\n'))).toBe('octocat');
    expect(fetchUserTeam('acme', gh(0, '[]'))).toBeNull();
    expect(
      fetchPrSnapshot(
        'acme',
        'widgets',
        7,
        gh(0, '{"reviewDecision":null,"statusCheckRollup":[]}'),
      ),
    ).toEqual({ ciStatus: null, reviewDecision: null });
    expect(lookupFailures()).toBe(0);
  });
});
