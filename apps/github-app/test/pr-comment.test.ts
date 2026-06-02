import type { RepoConfig } from '@ai-agents-observability/schemas';
import { describe, expect, it, vi } from 'vitest';

// Mock the github client so postPRComment doesn't hit the network.
const requestMock = vi.fn();
vi.mock('@ai-agents-observability/github', () => ({
  createGitHubClient: () => ({ request: requestMock }),
}));

import { buildCommentBody, COMMENT_MARKER, postPRComment } from '../src/lib/pr-comment';

const repoConfig: RepoConfig = {
  pr_bot: { enabled: true, include_cost: true, include_tool_counts: true },
  version: 1,
} as RepoConfig;

const rollup = {
  contributingSessionIds: ['a', 'b'],
  contributingUserIds: ['u1'],
  totalActiveSeconds: 3660,
  totalCostUsd: 3.4,
  totalToolCalls: 87,
};

describe('buildCommentBody', () => {
  it('starts with the bot marker and includes cost/tool counts', () => {
    const body = buildCommentBody(rollup, repoConfig);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('2 sessions · 1 contributor');
    expect(body).toContain('$3.40 total cost · 87 tool calls');
    expect(body).toContain('Active time: 1h 1m');
  });
});

describe('postPRComment idempotency', () => {
  it('skips posting when a bot comment already exists', async () => {
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce({ data: [{ body: `${COMMENT_MARKER}\n• prior` }] });

    const posted = await postPRComment('acme', 'repo', 42, 'body', 'token', 'https://github.com');

    expect(posted).toBe(false);
    // Only the GET (list) happened — no POST.
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('posts when no bot comment is present', async () => {
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce({ data: [{ body: 'unrelated' }] });
    requestMock.mockResolvedValueOnce({ data: {} });

    const posted = await postPRComment('acme', 'repo', 42, 'body', 'token', 'https://github.com');

    expect(posted).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
