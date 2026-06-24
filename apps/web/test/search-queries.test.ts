import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

const mockPrisma = {
  $queryRaw: vi.fn(),
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
  Prisma: {
    empty: { strings: [''], values: [] },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

function mrow(sessionId: string, idx: number) {
  return {
    content_text: `excerpt ${sessionId}-${idx}`,
    github_login: 'me',
    github_name: 'app',
    github_owner: 'acme',
    message_idx: idx,
    role: 'assistant',
    session_id: sessionId,
    started_at: new Date('2026-01-15T09:00:00Z'),
    ts: new Date('2026-01-15T09:05:00Z'),
  };
}

beforeEach(() => {
  mockPrisma.$queryRaw.mockReset();
});

describe('searchOwnTranscripts', () => {
  it('does not hit the DB for a too-short query', async () => {
    const { searchOwnTranscripts } = await import('../src/lib/search-queries.js');
    const result = await searchOwnTranscripts('u1', 'a');

    expect(result).toEqual({ page: 1, pageSize: 20, sessions: [], total: 0 });
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('groups matches by session, capping at 3 excerpts, preserving rank order', async () => {
    // Session A appears first (best-ranked) with 4 messages; session B with 1.
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      mrow('A', 0),
      mrow('A', 1),
      mrow('A', 2),
      mrow('A', 3),
      mrow('B', 0),
    ]);

    const { searchOwnTranscripts } = await import('../src/lib/search-queries.js');
    const result = await searchOwnTranscripts('u1', 'deploy');

    expect(result.total).toBe(2);
    expect(result.sessions[0]?.sessionId).toBe('A');
    expect(result.sessions[0]?.excerpts).toHaveLength(3); // capped
    expect(result.sessions[0]?.repoName).toBe('acme/app');
    expect(result.sessions[1]?.sessionId).toBe('B');
    expect(result.sessions[1]?.excerpts).toHaveLength(1);
  });

  it('paginates sessions 20 per page', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => mrow(`s${String(i).padStart(2, '0')}`, 0));
    mockPrisma.$queryRaw.mockResolvedValueOnce(rows);

    const { searchOwnTranscripts } = await import('../src/lib/search-queries.js');
    const result = await searchOwnTranscripts('u1', 'deploy', 2);

    expect(result.total).toBe(25);
    expect(result.page).toBe(2);
    expect(result.sessions).toHaveLength(5); // 25 - 20
  });

  it('returns no sessions for a query with zero matches', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    const { searchOwnTranscripts } = await import('../src/lib/search-queries.js');
    const result = await searchOwnTranscripts('u1', 'nonsense');

    expect(result.total).toBe(0);
    expect(result.sessions).toEqual([]);
  });
});
