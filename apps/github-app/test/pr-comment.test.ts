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

  it('leaves the header unlabelled for a single claude_code agent (unchanged)', () => {
    const body = buildCommentBody(rollup, repoConfig, ['CLAUDE_CODE']);
    expect(body).toContain('🤖 **AI agent summary**');
    expect(body).not.toContain('(');
  });

  it('labels the header for a single non-Claude agent', () => {
    const body = buildCommentBody(rollup, repoConfig, ['OPENCODE']);
    expect(body).toContain('🤖 **AI agent summary** (opencode)');
  });

  it('lists all distinct agents for a multi-agent PR', () => {
    const body = buildCommentBody(rollup, repoConfig, ['CLAUDE_CODE', 'OPENCODE', 'CLAUDE_CODE']);
    expect(body).toContain('🤖 **AI agent summary** (Claude Code, opencode)');
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

  it('finds a marker beyond the first page and skips posting', async () => {
    requestMock.mockReset();
    // Page 1: a full page (100) with no marker → must fetch page 2.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ body: `comment ${i}` }));
    requestMock.mockResolvedValueOnce({ data: fullPage });
    requestMock.mockResolvedValueOnce({ data: [{ body: `${COMMENT_MARKER}\n• prior` }] });

    const posted = await postPRComment('acme', 'repo', 42, 'body', 'token', 'https://github.com');

    expect(posted).toBe(false);
    // page 1 + page 2 GET, no POST
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
