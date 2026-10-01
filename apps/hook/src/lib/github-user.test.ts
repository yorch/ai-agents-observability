import { describe, expect, it } from 'bun:test';

import { GH_TIMEOUT_MS } from './github-pr';
import { fetchGitHubLogin, fetchUserTeam } from './github-user';

type GhSpawn = typeof Bun.spawnSync;

function spawnResult(stdout: string, exitCode = 0): ReturnType<GhSpawn> {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout).buffer,
  } as unknown as ReturnType<GhSpawn>;
}

// ── fetchGitHubLogin ────────────────────────────────────────────────────────

describe('fetchGitHubLogin', () => {
  it('returns null when gh is unavailable or not authenticated', () => {
    const result = fetchGitHubLogin(() => spawnResult('', 1));
    expect(result).toBeNull();
  });

  it('returns the authenticated login from gh output', () => {
    const result = fetchGitHubLogin(() => spawnResult('octocat\n'));
    expect(result).toBe('octocat');
  });

  it('returns null when gh prints an empty login', () => {
    const result = fetchGitHubLogin(() => spawnResult('\n'));
    expect(result).toBeNull();
  });
});

// ── fetchUserTeam ───────────────────────────────────────────────────────────

describe('fetchUserTeam', () => {
  it('returns null when gh is unavailable or not authenticated', () => {
    const result = fetchUserTeam('acme', () => spawnResult('', 1));
    expect(result).toBeNull();
  });

  it('returns the first team for the requested owner case-insensitively', () => {
    const result = fetchUserTeam('ACME', () =>
      spawnResult(
        JSON.stringify([
          { name: 'Other Team', organization: { login: 'other' } },
          { name: 'Platform', organization: { login: 'acme' } },
        ]),
      ),
    );

    expect(result).toBe('Platform');
  });

  it('returns null when the user has no team in the requested owner', () => {
    const result = fetchUserTeam('acme', () =>
      spawnResult(JSON.stringify([{ name: 'Other Team', organization: { login: 'other' } }])),
    );

    expect(result).toBeNull();
  });

  it('returns null when gh returns malformed JSON', () => {
    const result = fetchUserTeam('acme', () => spawnResult('not json'));
    expect(result).toBeNull();
  });
});

// ── timeouts ────────────────────────────────────────────────────────────────

describe('gh timeouts', () => {
  const hung = (seen: Array<{ timeout?: number } | undefined>) =>
    ((_cmd: unknown, opts: { timeout?: number }) => {
      seen.push(opts);
      return { exitCode: null, stdout: new Uint8Array() };
    }) as unknown as GhSpawn;

  it('fetchGitHubLogin bounds gh and treats a timeout as no login', () => {
    const seen: Array<{ timeout?: number } | undefined> = [];
    expect(fetchGitHubLogin(hung(seen))).toBeNull();
    expect(seen[0]?.timeout).toBe(GH_TIMEOUT_MS);
  });

  it('fetchUserTeam bounds gh and treats a timeout as no team', () => {
    const seen: Array<{ timeout?: number } | undefined> = [];
    expect(fetchUserTeam('acme', hung(seen))).toBeNull();
    expect(seen[0]?.timeout).toBe(GH_TIMEOUT_MS);
  });
});
