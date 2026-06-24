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
    status: 'COMPLETED',
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
    findUnique: vi.fn(),
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

  it('applies shape, friction-band, and agent filters in the where clause', async () => {
    mockPrisma.session.count.mockResolvedValueOnce(0);
    mockPrisma.session.findMany.mockResolvedValueOnce([]);

    const { listSessions } = await import('../src/lib/sessions-queries.js');
    await listSessions('u1', {
      agentTypes: ['CLAUDE_CODE'],
      frictionBand: 'high',
      page: 1,
      shapeLabels: ['debugging', 'focused-edit'],
    });

    expect(mockPrisma.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentType: { in: ['CLAUDE_CODE'] },
          frictionScore: { gt: 0.6 },
          shapeLabel: { in: ['debugging', 'focused-edit'] },
          userId: 'u1',
        }),
      }),
    );
  });

  it('omits effectiveness predicates when no filters are supplied', async () => {
    mockPrisma.session.count.mockResolvedValueOnce(0);
    mockPrisma.session.findMany.mockResolvedValueOnce([]);

    const { listSessions } = await import('../src/lib/sessions-queries.js');
    await listSessions('u1', { page: 1 });

    const call = mockPrisma.session.findMany.mock.calls.at(-1)?.[0];
    expect(call.where).not.toHaveProperty('shapeLabel');
    expect(call.where).not.toHaveProperty('frictionScore');
    expect(call.where).not.toHaveProperty('agentType');
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

// ── getSessionOrgContext ───────────────────────────────────────────────────────

describe('getSessionOrgContext', () => {
  it('returns null if the session does not exist', async () => {
    mockPrisma.session.findUnique.mockResolvedValueOnce(null);

    const { getSessionOrgContext } = await import('../src/lib/sessions-queries.js');
    expect(await getSessionOrgContext('nope')).toBeNull();
  });

  it('does NOT scope by userId — org-admin drill-in resolves any session by id', async () => {
    mockPrisma.session.findUnique.mockResolvedValueOnce({
      user: { displayName: 'Dee', githubLogin: 'dev', visibilityPolicy: null },
      userId: 'owner-1',
    });

    const { getSessionOrgContext } = await import('../src/lib/sessions-queries.js');
    await getSessionOrgContext('sess-1');

    // The lookup is intentionally unscoped — gating happens in the page/route via
    // requireOrgAdmin() + audit, not here.
    expect(mockPrisma.session.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: 'sess-1' } }),
    );
  });

  it('reads shareTranscriptsWithOrg + transcript pointer from the owner row', async () => {
    mockPrisma.session.findUnique.mockResolvedValueOnce({
      transcriptS3Key: 'transcripts/2026/01/15/owner-1/sess-1.jsonl.zst',
      user: {
        displayName: 'Dee',
        githubLogin: 'dev',
        visibilityPolicy: { shareTranscriptsWithOrg: true },
      },
      userId: 'owner-1',
    });

    const { getSessionOrgContext } = await import('../src/lib/sessions-queries.js');
    const ctx = await getSessionOrgContext('sess-1');

    expect(ctx?.ownerUserId).toBe('owner-1');
    expect(ctx?.ownerLogin).toBe('dev');
    expect(ctx?.shareTranscriptsWithOrg).toBe(true);
    expect(ctx?.transcriptS3Key).toBe('transcripts/2026/01/15/owner-1/sess-1.jsonl.zst');
  });

  it('defaults shareTranscriptsWithOrg to false when no policy row exists', async () => {
    mockPrisma.session.findUnique.mockResolvedValueOnce({
      user: { displayName: null, githubLogin: 'dev', visibilityPolicy: null },
      userId: 'owner-1',
    });

    const { getSessionOrgContext } = await import('../src/lib/sessions-queries.js');
    const ctx = await getSessionOrgContext('sess-1');

    expect(ctx?.shareTranscriptsWithOrg).toBe(false);
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
