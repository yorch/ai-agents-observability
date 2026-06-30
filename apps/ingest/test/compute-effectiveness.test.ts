import type { PrismaClient } from '@ai-agents-observability/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runComputeEffectivenessBackfill } from '../src/jobs/compute-effectiveness.ts';

function asDb(mock: ReturnType<typeof makeMockDb>): PrismaClient {
  return mock as unknown as PrismaClient;
}

// ── Query introspection ──────────────────────────────────────────────────────
// The job mixes two call styles: tagged-template `$queryRaw` (advisory lock /
// unlock) and `$queryRaw(Prisma.sql\`…\`)` / `$executeRaw(Prisma.sql\`…\`)` for the
// SELECT/UPDATE statements. Normalize both to { text, values } for matching.

function introspect(arg0: unknown, rest: unknown[]): { text: string; values: unknown[] } {
  if (Array.isArray(arg0)) {
    return { text: (arg0 as string[]).join(' '), values: rest };
  }
  const sql = arg0 as { sql?: string; strings?: string[]; values?: unknown[] };
  const text = sql.strings ? sql.strings.join(' ') : (sql.sql ?? String(arg0));
  return { text, values: sql.values ?? [] };
}

// ── Mock PrismaClient ────────────────────────────────────────────────────────

interface MockSession {
  ended_at: Date | null;
  friction_score: number | null;
  interrupt_count: number;
  permission_deny_count: number;
  session_id: string;
  shape_label: string | null;
  started_at: Date;
  status: string;
  tool_call_count: number;
  tool_error_count: number;
  user_message_count: number;
}

interface MockJobRun {
  errorText: string | null;
  finishedAt: Date | null;
  id: bigint;
  jobName: string;
  startedAt: Date;
  status: string;
}

function makeMockDb(opts?: { lockAlwaysFails?: boolean }) {
  const sessions: MockSession[] = [];
  // session_id -> [{ tool_name, count }]
  const histograms = new Map<string, { count: number; tool_name: string }[]>();
  const jobRuns: MockJobRun[] = [];
  let jobRunIdCounter = 1n;
  let lockHeld = false;
  let updateCount = 0;

  function runSelect(text: string, values: unknown[]): unknown[] {
    // Tool histogram fetch.
    if (text.includes('PostToolUse')) {
      const ids = (values[0] as string[]) ?? [];
      const rows: { call_count: bigint; session_id: string; tool_name: string }[] = [];
      for (const id of ids) {
        for (const h of histograms.get(id) ?? []) {
          rows.push({ call_count: BigInt(h.count), session_id: id, tool_name: h.tool_name });
        }
      }
      return rows;
    }
    // Backfill candidate fetch: WHERE shape_label IS NULL AND session_id > cursor.
    if (text.includes('ORDER BY session_id')) {
      const cursor = values[0] as string;
      const limit = Number(values[1] ?? 500);
      return sessions
        .filter((s) => s.shape_label === null && s.session_id > cursor)
        .sort((a, b) => (a.session_id < b.session_id ? -1 : 1))
        .slice(0, limit);
    }
    // Nightly window fetch (not exercised by the backfill tests).
    if (text.includes('last_event_at')) {
      return sessions.filter((s) => s.shape_label === null).slice(0, 500);
    }
    return [];
  }

  return {
    _histograms: histograms,
    _jobRuns: jobRuns,
    _sessions: sessions,
    get _updateCount() {
      return updateCount;
    },
    $executeRaw: vi.fn(async (arg0: unknown, ...rest: unknown[]) => {
      const { text, values } = introspect(arg0, rest);
      if (text.includes('UPDATE sessions')) {
        // Param order: friction_score, shape_label, total_response_ms,
        // response_sample_count, session_id.
        const [friction, shape, , , id] = values as [number | null, string, number, number, string];
        const s = sessions.find((x) => x.session_id === id);
        if (s) {
          s.friction_score = friction;
          s.shape_label = shape;
          updateCount++;
        }
        return 1;
      }
      return 0;
    }),
    $queryRaw: vi.fn(async (arg0: unknown, ...rest: unknown[]) => {
      const { text, values } = introspect(arg0, rest);
      if (text.includes('pg_try_advisory_lock')) {
        if (opts?.lockAlwaysFails) {
          return [{ pg_try_advisory_lock: false }];
        }
        if (!lockHeld) {
          lockHeld = true;
          return [{ pg_try_advisory_lock: true }];
        }
        return [{ pg_try_advisory_lock: false }];
      }
      if (text.includes('pg_advisory_unlock')) {
        lockHeld = false;
        return [{ pg_advisory_unlock: true }];
      }
      return runSelect(text, values);
    }),
    jobRun: {
      create: vi.fn(async (args: { data: Omit<MockJobRun, 'id'> }) => {
        const id = jobRunIdCounter++;
        const run: MockJobRun = { id, ...args.data } as MockJobRun;
        jobRuns.push(run);
        return run;
      }),
      update: vi.fn(async (args: { data: Partial<MockJobRun>; where: { id: bigint } }) => {
        const run = jobRuns.find((r) => r.id === args.where.id);
        if (run) {
          Object.assign(run, args.data);
        }
        return run;
      }),
    },
  };
}

function pushSession(
  db: ReturnType<typeof makeMockDb>,
  s: Partial<MockSession> & { session_id: string },
  histogram?: { count: number; tool_name: string }[],
) {
  db._sessions.push({
    ended_at: null,
    friction_score: null,
    interrupt_count: 0,
    permission_deny_count: 0,
    shape_label: null,
    started_at: new Date('2026-01-01T00:00:00Z'),
    status: 'COMPLETED',
    tool_call_count: 0,
    tool_error_count: 0,
    user_message_count: 0,
    ...s,
  });
  if (histogram) {
    db._histograms.set(s.session_id, histogram);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runComputeEffectivenessBackfill', () => {
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
  });

  it('scores all historical unscored sessions regardless of recency', async () => {
    pushSession(db, { session_id: 'a', tool_call_count: 10, user_message_count: 4 }, [
      { count: 8, tool_name: 'Read' },
      { count: 2, tool_name: 'Glob' },
    ]);
    pushSession(db, { session_id: 'b', tool_call_count: 10, user_message_count: 4 }, [
      { count: 9, tool_name: 'Edit' },
    ]);

    await runComputeEffectivenessBackfill(asDb(db));

    expect(db._sessions.every((s) => s.shape_label !== null)).toBe(true);
    expect(db._sessions.find((s) => s.session_id === 'a')?.shape_label).toBe('exploratory');
    expect(db._sessions.find((s) => s.session_id === 'b')?.shape_label).toBe('focused-edit');
  });

  it('keeps friction_score null for insufficient-data sessions (not 0)', async () => {
    // toolCallCount < 2 AND userMessageCount < 2 → friction null; shape 'minimal'.
    pushSession(db, { session_id: 'thin', tool_call_count: 0, user_message_count: 1 });

    await runComputeEffectivenessBackfill(asDb(db));

    const s = db._sessions[0];
    expect(s?.friction_score).toBeNull();
    expect(s?.shape_label).toBe('minimal');
  });

  it('is a no-op on re-run over an already-backfilled dataset', async () => {
    pushSession(db, { session_id: 'a', tool_call_count: 5, user_message_count: 5 }, [
      { count: 5, tool_name: 'Read' },
    ]);

    await runComputeEffectivenessBackfill(asDb(db));
    const afterFirst = db._updateCount;
    expect(afterFirst).toBe(1);

    await runComputeEffectivenessBackfill(asDb(db));
    expect(db._updateCount).toBe(afterFirst); // no further updates
  });

  it('processes across multiple batches when batchSize is small', async () => {
    for (let i = 0; i < 5; i++) {
      pushSession(db, { session_id: `s${i}`, tool_call_count: 5, user_message_count: 5 }, [
        { count: 5, tool_name: 'Read' },
      ]);
    }

    await runComputeEffectivenessBackfill(asDb(db), undefined, 2);

    expect(db._sessions.every((s) => s.shape_label !== null)).toBe(true);
    expect(db._updateCount).toBe(5);
  });

  it('writes a job_runs row with status=success', async () => {
    await runComputeEffectivenessBackfill(asDb(db));

    expect(db._jobRuns).toHaveLength(1);
    expect(db._jobRuns[0]?.jobName).toBe('compute-effectiveness-backfill');
    expect(db._jobRuns[0]?.status).toBe('success');
    expect(db._jobRuns[0]?.finishedAt).toBeInstanceOf(Date);
  });

  it('skips the run if the advisory lock is not available', async () => {
    const locked = makeMockDb({ lockAlwaysFails: true });
    pushSession(locked, { session_id: 'a', tool_call_count: 5, user_message_count: 5 });

    await runComputeEffectivenessBackfill(asDb(locked));

    expect(locked._jobRuns).toHaveLength(0);
    expect(locked._sessions[0]?.shape_label).toBeNull();
  });
});
