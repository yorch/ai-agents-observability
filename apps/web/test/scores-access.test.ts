import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The read-path half of the P13-009 exposure rule.
 *
 * `test/judge-owner-only.test.ts` lints the source for judge scorer *names* —
 * useful, but a query written as `where: { source: 'JUDGE' }` never names one
 * and sails past it. (`getJudgeSpend` is written exactly that way, legitimately.)
 * So the guarantee has to live in the read path: `readScores` returns a judge
 * row's `label`/`rationale_ref` only against an owner id it verifies against
 * `sessions.user_id` itself, and hands every other caller a row shape with no
 * label on it at all.
 *
 * These tests are the ones that fail if that is undone.
 */

const mockPrisma = {
  score: { findMany: vi.fn() },
  session: { findMany: vi.fn() },
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
  Prisma: {},
  // Identity: these suites assert on the mock client's calls. That the real
  // extension actually filters is proven by test/run-kind-coverage.test.ts
  // and against a live database, not here.
  withInteractiveOnly: <T>(c: T): T => c,
}));

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
  mockPrisma.score.findMany.mockReset();
  mockPrisma.session.findMany.mockReset();
  mockPrisma.session.findMany.mockResolvedValue([]);
});

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const OWNER = 'owner-user';
const SOMEONE_ELSE = 'manager-user';

function judgeRow(over: Record<string, unknown> = {}) {
  return {
    costUsd: 0.02,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    label: 'partly',
    metadata: {},
    rationaleRef: 'judge-rationales/abc/v1.json',
    scorerName: 'judge_task_completion',
    scorerVersion: 1,
    source: 'JUDGE',
    subjectId: SESSION_ID,
    subjectType: 'SESSION',
    value: null,
    ...over,
  };
}

function humanRow(over: Record<string, unknown> = {}) {
  return {
    costUsd: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    label: 'yes',
    metadata: {},
    rationaleRef: null,
    scorerName: 'human_task_outcome',
    scorerVersion: 1,
    source: 'HUMAN',
    subjectId: SESSION_ID,
    subjectType: 'SESSION',
    value: null,
    ...over,
  };
}

describe('readScores — judge rows require verified ownership', () => {
  it('returns the label to the session owner', async () => {
    mockPrisma.score.findMany.mockResolvedValue([judgeRow()]);
    mockPrisma.session.findMany.mockResolvedValue([{ sessionId: SESSION_ID }]);

    const { readScores } = await import('../src/lib/scores.js');
    const rows = await readScores(
      { subjectIds: [SESSION_ID], subjectType: 'SESSION' },
      { kind: 'owner', ownerUserId: OWNER },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('partly');
    // Ownership is proved by a query here, not asserted by the caller.
    expect(mockPrisma.session.findMany).toHaveBeenCalledWith({
      select: { sessionId: true },
      where: { sessionId: { in: [SESSION_ID] }, userId: OWNER },
    });
  });

  it('blocks the un-owned read — a manager gets no verdict about someone else', async () => {
    mockPrisma.score.findMany.mockResolvedValue([judgeRow()]);
    // The ownership probe finds nothing: this session is not theirs.
    mockPrisma.session.findMany.mockResolvedValue([]);

    const { readScores } = await import('../src/lib/scores.js');
    const rows = await readScores(
      { subjectIds: [SESSION_ID], subjectType: 'SESSION' },
      { kind: 'owner', ownerUserId: SOMEONE_ELSE },
    );

    expect(rows).toEqual([]);
  });

  it('leaves non-judge rows alone — the gate is on the judge, not on scores', async () => {
    mockPrisma.score.findMany.mockResolvedValue([humanRow(), judgeRow()]);
    mockPrisma.session.findMany.mockResolvedValue([]);

    const { readScores } = await import('../src/lib/scores.js');
    const rows = await readScores(
      { subjectIds: [SESSION_ID] },
      { kind: 'owner', ownerUserId: SOMEONE_ELSE },
    );

    expect(rows.map((r) => r.source)).toEqual(['HUMAN']);
    expect(rows[0]?.label).toBe('yes');
  });

  it('does not run an ownership probe when no judge row came back', async () => {
    mockPrisma.score.findMany.mockResolvedValue([humanRow()]);

    const { readScores } = await import('../src/lib/scores.js');
    await readScores({ subjectIds: [SESSION_ID] }, { kind: 'owner', ownerUserId: OWNER });

    expect(mockPrisma.session.findMany).not.toHaveBeenCalled();
  });

  it('cannot return a judge row whose subject is not a session, since ownership is unprovable', async () => {
    mockPrisma.score.findMany.mockResolvedValue([
      judgeRow({ subjectId: 'skill:review', subjectType: 'SKILL' }),
    ]);
    mockPrisma.session.findMany.mockResolvedValue([]);

    const { readScores } = await import('../src/lib/scores.js');
    const rows = await readScores({}, { kind: 'owner', ownerUserId: OWNER });

    expect(rows).toEqual([]);
  });
});

describe('readScores — the sanctioned aggregate-only exception', () => {
  it('strips every label and rationale pointer, judge or not', async () => {
    mockPrisma.score.findMany.mockResolvedValue([judgeRow(), humanRow()]);

    const { readScores } = await import('../src/lib/scores.js');
    const rows = await readScores({ source: 'JUDGE' }, { kind: 'aggregate-only', reason: 'test' });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty('label');
      expect(row).not.toHaveProperty('rationaleRef');
    }
    // What the exception is *for* still comes back.
    expect(rows[0]?.costUsd).toBe(0.02);
    expect(rows[0]?.subjectId).toBe(SESSION_ID);
    // And it never asks who owns anything, because it is never told a verdict.
    expect(mockPrisma.session.findMany).not.toHaveBeenCalled();
  });
});

describe('getJudgeSpend stays aggregate', () => {
  it('sums cost and counts subjects without reading a label', async () => {
    mockPrisma.score.findMany.mockResolvedValue([
      judgeRow({ costUsd: 0.02 }),
      judgeRow({ costUsd: 0.03, scorerName: 'judge_plan_coherence' }),
      judgeRow({ costUsd: 0.05, subjectId: '22222222-2222-2222-2222-222222222222' }),
    ]);

    const { getJudgeSpend } = await import('../src/lib/judge-queries.js');
    const spend = await getJudgeSpend(30);

    expect(spend.costUsd).toBeCloseTo(0.1, 6);
    expect(spend.scoredSessions).toBe(2);
    expect(mockPrisma.session.findMany).not.toHaveBeenCalled();
  });
});

describe('the judge scorer set is derived from the registry', () => {
  it('is every registered scorer whose source is JUDGE, not a hand-written pair', async () => {
    const { SCORER_NAMES, SCORERS } = await import('@ai-agents-observability/schemas');
    const { JUDGE_SCORER_NAMES } = await import('../src/lib/judge-queries.js');

    const expected = SCORER_NAMES.filter((n) => SCORERS[n].source === 'JUDGE');
    expect([...JUDGE_SCORER_NAMES].sort()).toEqual([...expected].sort());
    // Non-vacuous: the registry does declare judge scorers.
    expect(JUDGE_SCORER_NAMES.length).toBeGreaterThan(0);
  });
});
