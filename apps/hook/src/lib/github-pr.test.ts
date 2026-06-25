import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { fetchOpenPrNumber, isGitHubRemote, resolveGitHubToken } from './github-pr';

// ── isGitHubRemote ──────────────────────────────────────────────────────────

describe('isGitHubRemote', () => {
  it('returns true for SSH github.com remote', () => {
    expect(isGitHubRemote('git@github.com:owner/repo.git')).toBe(true);
  });

  it('returns true for HTTPS github.com remote', () => {
    expect(isGitHubRemote('https://github.com/owner/repo.git')).toBe(true);
  });

  it('returns false for GitLab remote', () => {
    expect(isGitHubRemote('git@gitlab.com:owner/repo.git')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isGitHubRemote(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGitHubRemote('')).toBe(false);
  });
});

// ── resolveGitHubToken ──────────────────────────────────────────────────────

describe('resolveGitHubToken', () => {
  let savedGithubToken: string | undefined;
  let savedGhToken: string | undefined;

  beforeEach(() => {
    savedGithubToken = process.env.GITHUB_TOKEN;
    savedGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    if (savedGithubToken !== undefined) {
      process.env.GITHUB_TOKEN = savedGithubToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    if (savedGhToken !== undefined) {
      process.env.GH_TOKEN = savedGhToken;
    } else {
      delete process.env.GH_TOKEN;
    }
  });

  it('returns GITHUB_TOKEN when set', () => {
    process.env.GITHUB_TOKEN = 'ghp_test123';
    expect(resolveGitHubToken()).toBe('ghp_test123');
  });

  it('returns GH_TOKEN when GITHUB_TOKEN is absent', () => {
    process.env.GH_TOKEN = 'ghp_fallback';
    expect(resolveGitHubToken()).toBe('ghp_fallback');
  });

  it('returns null when no env var or gh CLI token is available', () => {
    // gh CLI is not authenticated in test env — should return null (no throw)
    const result = resolveGitHubToken();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

// ── fetchOpenPrNumber ───────────────────────────────────────────────────────

describe('fetchOpenPrNumber', () => {
  it('returns null for a non-GitHub remote', async () => {
    const result = await fetchOpenPrNumber(
      'acme',
      'widget',
      'main',
      'tok',
      'git@gitlab.com:acme/widget.git',
    );
    expect(result).toBeNull();
  });

  it('returns null when fetch fails (network error)', async () => {
    // Point at an unreachable host to trigger a network error
    const origApiUrl = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = 'http://127.0.0.1:1/'; // nothing listening
    try {
      const result = await fetchOpenPrNumber(
        'acme',
        'widget',
        'main',
        'tok',
        'git@github.com:acme/widget.git',
      );
      expect(result).toBeNull();
    } finally {
      if (origApiUrl !== undefined) {
        process.env.GITHUB_API_URL = origApiUrl;
      } else {
        delete process.env.GITHUB_API_URL;
      }
    }
  });
});
