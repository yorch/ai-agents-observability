import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { fetchOpenPrNumber, isGitHubRemote } from './github-pr';

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

// ── fetchOpenPrNumber ───────────────────────────────────────────────────────

describe('fetchOpenPrNumber', () => {
  let origApiUrl: string | undefined;

  beforeEach(() => {
    origApiUrl = process.env.GITHUB_API_URL;
  });

  afterEach(() => {
    if (origApiUrl !== undefined) {
      process.env.GITHUB_API_URL = origApiUrl;
    } else {
      delete process.env.GITHUB_API_URL;
    }
  });

  it('returns null for a non-GitHub remote when gh is unavailable', async () => {
    // gh CLI is not authenticated in the test environment; API fallback skips
    // non-GitHub remotes, so this should always return null.
    const result = await fetchOpenPrNumber(
      'acme',
      'widget',
      'main',
      'git@gitlab.com:acme/widget.git',
    );
    expect(result).toBeNull();
  });

  it('returns null on API network error', async () => {
    process.env.GITHUB_API_URL = 'http://127.0.0.1:1/'; // nothing listening
    // gh will fail (not authenticated); API call will fail (unreachable host)
    const result = await fetchOpenPrNumber(
      'acme',
      'widget',
      'main',
      'git@github.com:acme/widget.git',
    );
    expect(result).toBeNull();
  });
});
