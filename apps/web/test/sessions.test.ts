import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

// ── Mock @ai-agents-observability/db ────────────────────────────────────────

const now = new Date('2026-01-15T10:00:00Z');
const start = new Date('2026-01-15T09:00:00Z');
const end = new Date('2026-01-15T09:30:00Z');

const mockSessions = [
  {
    sessionId: 'sess-1',
    userId: 'u1',
    startedAt: start,
    endedAt: end,
    status: 'completed',
    totalCostUsd: '0.25',
    toolCallCount: 5,
    userMessageCount: 3,
    repo: { githubOwner: 'acme', githubName: 'app' },
  },
];

const mockPrisma = {
  session: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
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
    expect(sessions[0]!.sessionId).toBe('sess-1');
    expect(sessions[0]!.repoName).toBe('acme/app');
    expect(sessions[0]!.costUsd).toBeCloseTo(0.25);
    expect(sessions[0]!.durationSeconds).toBe(30 * 60); // 30 min
    expect(sessions[0]!.eventCount).toBe(8); // 5 tool + 3 user
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

  it('returns session detail', async () => {
    mockPrisma.session.findFirst.mockResolvedValueOnce({
      ...mockSessions[0],
      agentVersion: null,
      claudeCodeVersion: '1.0.0',
      gitBranch: 'main',
      gitCommit: 'abc1234',
      haikuTurns: 0,
      opusTurns: 2,
      os: 'linux',
      permissionDenyCount: 0,
      permissionPromptCount: 1,
      primaryModel: 'claude-sonnet',
      sonnetTurns: 3,
      toolErrorCount: 1,
      totalInputTokens: 1000n,
      totalOutputTokens: 500n,
      transcriptS3Key: null,
      endReason: 'completed',
    });

    const { getSession } = await import('../src/lib/sessions-queries.js');
    const result = await getSession('u1', 'sess-1');

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sess-1');
    expect(result!.branch).toBe('main');
    expect(result!.commitSha).toBe('abc1234');
    expect(result!.durationSeconds).toBe(30 * 60);
  });
});

// ── listDistinctRepos ─────────────────────────────────────────────────────────

describe('listDistinctRepos', () => {
  it('returns sorted list of repo names', async () => {
    mockPrisma.session.findMany.mockResolvedValueOnce([
      { repo: { githubOwner: 'org', githubName: 'zebra' } },
      { repo: { githubOwner: 'org', githubName: 'alpha' } },
    ]);

    const { listDistinctRepos } = await import('../src/lib/sessions-queries.js');
    const result = await listDistinctRepos('u1');

    expect(result).toEqual(['org/alpha', 'org/zebra']);
  });
});
