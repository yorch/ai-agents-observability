import { describe, expect, it } from 'bun:test';

import { fetchGitHubLogin, fetchUserTeam } from './github-user';

// ── fetchGitHubLogin ────────────────────────────────────────────────────────

describe('fetchGitHubLogin', () => {
  it('returns null when gh is unavailable or not authenticated', () => {
    // In CI the gh CLI is not authenticated; spawnSync exits non-zero → null.
    const result = fetchGitHubLogin();
    expect(result).toBeNull();
  });
});

// ── fetchUserTeam ───────────────────────────────────────────────────────────

describe('fetchUserTeam', () => {
  it('returns null when gh is unavailable or not authenticated', () => {
    const result = fetchUserTeam('acme');
    expect(result).toBeNull();
  });
});
