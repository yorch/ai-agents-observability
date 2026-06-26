import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { fetchOpenPrNumber, fetchPrSnapshot, isGitHubRemote } from './github-pr';

type GhSpawn = typeof Bun.spawnSync;

function spawnResult(stdout: string, exitCode = 0): ReturnType<GhSpawn> {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout).buffer,
  } as unknown as ReturnType<GhSpawn>;
}

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

  it('recognizes a configured GHES host', () => {
    const origApiUrl = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = 'https://github.internal.example/api/v3';
    try {
      expect(isGitHubRemote('git@github.internal.example:owner/repo.git')).toBe(true);
      expect(isGitHubRemote('git@github.com:owner/repo.git')).toBe(false);
    } finally {
      if (origApiUrl !== undefined) {
        process.env.GITHUB_API_URL = origApiUrl;
      } else {
        delete process.env.GITHUB_API_URL;
      }
    }
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
    const result = await fetchOpenPrNumber(
      'acme',
      'widget',
      'main',
      'git@gitlab.com:acme/widget.git',
      () => spawnResult('', 1),
    );
    expect(result).toBeNull();
  });

  it('returns the PR number from gh output', async () => {
    const result = await fetchOpenPrNumber(
      'acme',
      'widget',
      'feature',
      'git@github.com:acme/widget.git',
      () => spawnResult(JSON.stringify([{ number: 42 }])),
    );

    expect(result).toBe(42);
  });

  it('returns null when gh returns malformed PR JSON and API fallback is unavailable', async () => {
    const result = await fetchOpenPrNumber(
      'acme',
      'widget',
      'feature',
      'git@gitlab.com:acme/widget.git',
      () => spawnResult('not json'),
    );

    expect(result).toBeNull();
  });

  it('returns null on API network error', async () => {
    process.env.GITHUB_API_URL = 'http://127.0.0.1:1/'; // nothing listening
    const result = await fetchOpenPrNumber(
      'acme',
      'widget',
      'main',
      'git@github.com:acme/widget.git',
      () => spawnResult('', 1),
    );
    expect(result).toBeNull();
  });
});

// ── fetchPrSnapshot ─────────────────────────────────────────────────────────

describe('fetchPrSnapshot', () => {
  it('returns null when gh is unavailable (not authenticated)', () => {
    const result = fetchPrSnapshot('acme', 'widget', 1, () => spawnResult('', 1));
    expect(result).toBeNull();
  });

  it('returns successful CI and approved review status from gh output', () => {
    const result = fetchPrSnapshot('acme', 'widget', 1, () =>
      spawnResult(
        JSON.stringify({
          reviewDecision: 'APPROVED',
          statusCheckRollup: [
            { conclusion: 'SUCCESS', status: 'COMPLETED' },
            { conclusion: 'SKIPPED', status: 'COMPLETED' },
          ],
        }),
      ),
    );

    expect(result).toEqual({ ciStatus: 'SUCCESS', reviewDecision: 'APPROVED' });
  });

  it('prioritizes failed CI checks over pending checks', () => {
    const result = fetchPrSnapshot('acme', 'widget', 1, () =>
      spawnResult(
        JSON.stringify({
          reviewDecision: 'REVIEW_REQUIRED',
          statusCheckRollup: [
            { conclusion: null, status: 'QUEUED' },
            { conclusion: 'FAILURE', status: 'COMPLETED' },
          ],
        }),
      ),
    );

    expect(result).toEqual({ ciStatus: 'FAILURE', reviewDecision: 'REVIEW_REQUIRED' });
  });

  it('returns pending CI and ignores unknown review decisions', () => {
    const result = fetchPrSnapshot('acme', 'widget', 1, () =>
      spawnResult(
        JSON.stringify({
          reviewDecision: 'COMMENTED',
          statusCheckRollup: [{ conclusion: null, status: 'IN_PROGRESS' }],
        }),
      ),
    );

    expect(result).toEqual({ ciStatus: 'PENDING', reviewDecision: null });
  });

  it('returns null CI status when there are no checks', () => {
    const result = fetchPrSnapshot('acme', 'widget', 1, () =>
      spawnResult(JSON.stringify({ reviewDecision: null, statusCheckRollup: [] })),
    );

    expect(result).toEqual({ ciStatus: null, reviewDecision: null });
  });

  it('returns null when gh returns malformed snapshot JSON', () => {
    const result = fetchPrSnapshot('acme', 'widget', 1, () => spawnResult('not json'));
    expect(result).toBeNull();
  });
});
