import { describe, expect, it, vi } from 'vitest';

import { createGitHubClient } from '../src/client';
import { getPRDetails } from '../src/helpers';

// ── Mock fetch factory ────────────────────────────────────────────────────────

function makeFetch(...responses: unknown[]) {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const body = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
  });
}

// ── Helper: getPRDetails ──────────────────────────────────────────────────────

describe('getPRDetails', () => {
  it('returns mapped PR details with review count', async () => {
    const prData = {
      additions: 42,
      changed_files: 3,
      deletions: 10,
      title: 'feat: my feature',
    };
    const reviewsData = [
      { id: 1, state: 'APPROVED' },
      { id: 2, state: 'COMMENTED' },
    ];

    const fetch = makeFetch(prData, reviewsData);
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });

    const result = await getPRDetails(client, 'myorg', 'my-repo', 7);

    expect(result).toEqual({
      filesChanged: 3,
      linesAdded: 42,
      linesRemoved: 10,
      reviewCount: 2,
      title: 'feat: my feature',
    });
  });

  it('returns reviewCount 0 when no reviews exist', async () => {
    const prData = {
      additions: 5,
      changed_files: 1,
      deletions: 2,
      title: 'chore: minor tweak',
    };

    const fetch = makeFetch(prData, []);
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });

    const result = await getPRDetails(client, 'myorg', 'my-repo', 99);

    expect(result).not.toBeNull();
    expect(result?.reviewCount).toBe(0);
  });

  it('returns null when the API returns a 404', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not Found' }), {
        headers: { 'content-type': 'application/json' },
        status: 404,
      }),
    );
    const client = createGitHubClient({ fetch, host: 'https://github.com', token: 'ghs_test' });

    const result = await getPRDetails(client, 'myorg', 'my-repo', 1);

    expect(result).toBeNull();
  });
});
