import { describe, expect, it } from 'bun:test';

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
