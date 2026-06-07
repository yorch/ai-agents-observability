import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

// ── Mock @ai-agents-observability/db ────────────────────────────────────────

const _now = new Date('2026-01-15T10:00:00Z');
const start = new Date('2026-01-15T09:00:00Z');
const end = new Date('2026-01-15T09:30:00Z');

const mockSessions = [
  {
    endedAt: end,
    repo: { githubName: 'app', githubOwner: 'acme' },
    sessionId: 'sess-1',
    startedAt: start,
    status: 'completed',
    toolCallCount: 5,
    totalCostUsd: '0.25',
    userId: 'u1',
    userMessageCount: 3,
  },
];

const mockPrisma = {
  session: {
    count: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
}));

// ── listSessions ─────────────────────────────────────────────────────────────

describe('listSessions', () => {
  it('returns sessions with computed fields', async () => {
    mockPrisma.session.count.mockResolvedValueOnce(1);
    mockPrisma.session.findMany.mockResolvedValueOnce(mockSessions);

    const { listSessions } = await import('../src/lib/sessions-queries.js');
    const { sessions, total } = await listSessions('u1', { page: 1 });

    expect(total).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('sess-1');
    expect(sessions[0]?.repoName).toBe('acme/app');
    expect(sessions[0]?.costUsd).toBeCloseTo(0.25);
    expect(sessions[0]?.durationSeconds).toBe(30 * 60); // 30 min
    expect(sessions[0]?.eventCount).toBe(8); // 5 tool + 3 user
  });

  it('returns empty when no sessions match', async () => {
    mockPrisma.session.count.mockResolvedValueOnce(0);
    mockPrisma.session.findMany.mockResolvedValueOnce([]);

    const { listSessions } = await import('../src/lib/sessions-queries.js');
    const { sessions, total } = await listSessions('u1', { page: 1 });

    expect(total).toBe(0);
    expect(sessions).toHaveLength(0);
  });
});

// ── getSession ────────────────────────────────────────────────────────────────

describe('getSession', () => {
  it('returns null if not found', async () => {
    mockPrisma.session.findFirst.mockResolvedValueOnce(null);

    const { getSession } = await import('../src/lib/sessions-queries.js');
    const result = await getSession('u1', 'non-existent');

    expect(result).toBeNull();
  });

  it('scopes the query to the authenticated user (IDOR resistance)', async () => {
    mockPrisma.session.findFirst.mockResolvedValueOnce(null);

    const { getSession } = await import('../src/lib/sessions-queries.js');
    await getSession('u1', 'sess-belonging-to-someone-else');

    // The userId MUST be part of the where clause — otherwise a user could read
    // another user's session by guessing its id.
    expect(mockPrisma.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: 'sess-belonging-to-someone-else', userId: 'u1' },
      }),
    );
  });

  it('returns session detail', async () => {
    mockPrisma.session.findFirst.mockResolvedValueOnce({
      ...mockSessions[0],
      agentVersion: null,
      claudeCodeVersion: '1.0.0',
      endReason: 'completed',
      gitBranch: 'main',
      gitCommit: 'abc1234',
      os: 'linux',
      permissionDenyCount: 0,
      permissionPromptCount: 1,
      primaryModel: 'claude-sonnet',
      toolErrorCount: 1,
      totalInputTokens: 1000n,
      totalOutputTokens: 500n,
      transcriptS3Key: null,
    });

    const { getSession } = await import('../src/lib/sessions-queries.js');
    const result = await getSession('u1', 'sess-1');

    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe('sess-1');
    expect(result?.branch).toBe('main');
    expect(result?.commitSha).toBe('abc1234');
    expect(result?.durationSeconds).toBe(30 * 60);
  });
});

// ── listDistinctRepos ─────────────────────────────────────────────────────────

describe('listDistinctRepos', () => {
  it('returns sorted list of repo names', async () => {
    mockPrisma.session.findMany.mockResolvedValueOnce([
      { repo: { githubName: 'zebra', githubOwner: 'org' } },
      { repo: { githubName: 'alpha', githubOwner: 'org' } },
    ]);

    const { listDistinctRepos } = await import('../src/lib/sessions-queries.js');
    const result = await listDistinctRepos('u1');

    expect(result).toEqual(['org/alpha', 'org/zebra']);
  });
});
