import type { PrismaClient } from '@ai-agents-observability/db';
import { SCORERS, TRAJECTORY_MIN_TOOL_CALLS } from '@ai-agents-observability/schemas';
import { describe, expect, it, vi } from 'vitest';

import { buildSubjectScoreInputs } from '../src/jobs/compute-subject-scores';
import {
  loadStepBaselines,
  MAX_EVENTS_PER_SESSION,
  processTrajectoryBatch,
} from '../src/jobs/compute-trajectory-scores';

// The batch processor's contract is what this file checks: which `scores` rows a
// batch produces, and — more importantly — which it *declines* to produce. The
// scorers themselves are unit-tested against fixture trajectories in
// packages/schemas/src/trajectory.test.ts; duplicating that here would test the
// fixtures twice and the job not at all.

type Captured = {
  scorerName: string;
  scorerVersion: number;
  subjectId: string;
  subjectType: string;
  value: number | null;
};

function introspect(arg0: unknown, rest: unknown[]): { text: string; values: unknown[] } {
  if (Array.isArray(arg0)) {
    return { text: (arg0 as string[]).join(' '), values: rest };
  }
  const sql = arg0 as { sql?: string; strings?: string[]; values?: unknown[] };
  const text = sql.strings ? sql.strings.join(' ') : (sql.sql ?? String(arg0));
  return { text, values: sql.values ?? [] };
}

type EventFixture = {
  agent_type?: string;
  event_type?: string;
  session_id: string;
  tool_action?: string | null;
  tool_exit_status?: number | null;
  tool_input_hash?: string | null;
  tool_name: string | null;
  tool_target_hash?: string | null;
  tool_was_denied?: boolean | null;
  tool_was_interrupted?: boolean | null;
};

function makeMockDb(events: EventFixture[], mergedSessions: string[] = []) {
  const captured: Captured[] = [];

  return {
    _captured: captured,
    $executeRaw: vi.fn(async (arg0: unknown, ...rest: unknown[]) => {
      const { text, values } = introspect(arg0, rest);
      if (text.includes('INSERT INTO scores')) {
        // Value order follows scoreUpsert()'s VALUES list.
        const [subjectType, subjectId, scorerName, scorerVersion, , value] = values as [
          string,
          string,
          string,
          number,
          string,
          number | null,
        ];
        captured.push({ scorerName, scorerVersion, subjectId, subjectType, value });
      }
      return 1;
    }),
    $queryRaw: vi.fn(async (arg0: unknown, ...rest: unknown[]) => {
      const { text } = introspect(arg0, rest);
      if (text.includes('session_pr_links')) {
        return mergedSessions.map((id) => ({ merged_at: new Date('2026-08-01'), session_id: id }));
      }
      if (text.includes('ROW_NUMBER()')) {
        return events.map((e) => ({
          agent_type: e.agent_type ?? 'CLAUDE_CODE',
          event_type: e.event_type ?? 'PostToolUse',
          session_id: e.session_id,
          tool_action: e.tool_action ?? null,
          tool_exit_status: e.tool_exit_status === undefined ? 0 : e.tool_exit_status,
          tool_input_hash: e.tool_input_hash ?? null,
          tool_name: e.tool_name,
          tool_target_hash: e.tool_target_hash ?? null,
          tool_was_denied: e.tool_was_denied ?? false,
          tool_was_interrupted: e.tool_was_interrupted ?? false,
        }));
      }
      return [];
    }),
    $transaction: vi.fn(async (statements: Promise<unknown>[]) => Promise.all(statements)),
  };
}

type MockDb = ReturnType<typeof makeMockDb>;
function asDb(mock: MockDb): Parameters<typeof processTrajectoryBatch>[0] {
  return mock as unknown as PrismaClient;
}

const SESSION = '11111111-1111-1111-1111-111111111111';

function readEvents(count: number, target = (i: number) => `t${i}`): EventFixture[] {
  return Array.from({ length: count }, (_, i) => ({
    session_id: SESSION,
    tool_name: 'Read',
    tool_target_hash: target(i),
  }));
}

const BASELINES = new Map([
  ['exploratory', { medianToolCalls: 20, sessionCount: 50, shapeLabel: 'exploratory' }],
]);

describe('processTrajectoryBatch', () => {
  it('writes a row per scorer that produced a value, keyed to the session', async () => {
    const db = makeMockDb(readEvents(8));
    const written = await processTrajectoryBatch(
      asDb(db),
      [
        {
          agent_type: 'CLAUDE_CODE',
          session_id: SESSION,
          shape_label: 'exploratory',
          tool_call_count: 8,
        },
      ],
      BASELINES,
    );

    expect(written).toBe(1);
    const names = db._captured.map((c) => c.scorerName).sort();
    // Edit-thrash has no writes to score; everything else does.
    expect(names).toEqual([
      'trajectory_denial_retry_success',
      'trajectory_redundant_read',
      'trajectory_retry_loop',
      'trajectory_step_efficiency',
    ]);
    for (const row of db._captured) {
      expect(row.subjectType).toBe('SESSION');
      expect(row.subjectId).toBe(SESSION);
    }
  });

  it('stamps each row with its own scorer version from the registry', async () => {
    const db = makeMockDb(readEvents(8));
    await processTrajectoryBatch(
      asDb(db),
      [
        {
          agent_type: 'CLAUDE_CODE',
          session_id: SESSION,
          shape_label: 'exploratory',
          tool_call_count: 8,
        },
      ],
      BASELINES,
    );
    const retry = db._captured.find((c) => c.scorerName === 'trajectory_retry_loop');
    expect(retry?.scorerVersion).toBe(SCORERS.trajectory_retry_loop.version);
  });

  it('writes nothing for a session too small to characterize', async () => {
    const db = makeMockDb(readEvents(2));
    const written = await processTrajectoryBatch(
      asDb(db),
      [
        {
          agent_type: 'CLAUDE_CODE',
          session_id: SESSION,
          shape_label: 'exploratory',
          tool_call_count: 2,
        },
      ],
      BASELINES,
    );
    expect(written).toBe(0);
    expect(db._captured).toEqual([]);
  });

  it('omits step efficiency when the shape has no usable baseline', async () => {
    const db = makeMockDb(readEvents(8));
    await processTrajectoryBatch(
      asDb(db),
      [
        {
          agent_type: 'CLAUDE_CODE',
          session_id: SESSION,
          shape_label: 'debugging',
          tool_call_count: 8,
        },
      ],
      BASELINES,
    );
    expect(db._captured.some((c) => c.scorerName === 'trajectory_step_efficiency')).toBe(false);
  });

  it('writes tests-before-merge only for a session whose linked PR merged', async () => {
    const events = [
      ...readEvents(6),
      { session_id: SESSION, tool_action: 'test', tool_name: 'Bash', tool_target_hash: 'cmd' },
    ];
    const withoutPr = makeMockDb(events);
    await processTrajectoryBatch(
      asDb(withoutPr),
      [
        {
          agent_type: 'CLAUDE_CODE',
          session_id: SESSION,
          shape_label: 'exploratory',
          tool_call_count: 7,
        },
      ],
      BASELINES,
    );
    expect(withoutPr._captured.some((c) => c.scorerName === 'trajectory_tests_before_merge')).toBe(
      false,
    );

    const withPr = makeMockDb(events, [SESSION]);
    await processTrajectoryBatch(
      asDb(withPr),
      [
        {
          agent_type: 'CLAUDE_CODE',
          session_id: SESSION,
          shape_label: 'exploratory',
          tool_call_count: 7,
        },
      ],
      BASELINES,
    );
    const row = withPr._captured.find((c) => c.scorerName === 'trajectory_tests_before_merge');
    expect(row?.value).toBe(1);
  });

  it('omits tests-before-merge when no command in the session was classifiable', async () => {
    // The distinction that matters: an adapter that derives no action must not
    // make a merged session read as "shipped without tests".
    const db = makeMockDb(readEvents(8), [SESSION]);
    await processTrajectoryBatch(
      asDb(db),
      [
        {
          agent_type: 'CLAUDE_CODE',
          session_id: SESSION,
          shape_label: 'exploratory',
          tool_call_count: 8,
        },
      ],
      BASELINES,
    );
    expect(db._captured.some((c) => c.scorerName === 'trajectory_tests_before_merge')).toBe(false);
  });

  it('marks a session truncated only when an event was actually dropped', async () => {
    const atCap = makeMockDb(readEvents(MAX_EVENTS_PER_SESSION));
    const overCap = makeMockDb(readEvents(MAX_EVENTS_PER_SESSION + 1));
    const session = (count: number) => [
      {
        agent_type: 'CLAUDE_CODE',
        session_id: SESSION,
        shape_label: 'exploratory',
        tool_call_count: count,
      },
    ];

    await processTrajectoryBatch(asDb(atCap), session(MAX_EVENTS_PER_SESSION), BASELINES);
    await processTrajectoryBatch(asDb(overCap), session(MAX_EVENTS_PER_SESSION + 1), BASELINES);

    const metadataFlags = (db: MockDb): boolean[] =>
      db.$executeRaw.mock.calls
        .map((call) => introspect(call[0], call.slice(1)))
        .filter((c) => c.text.includes('INSERT INTO scores'))
        .flatMap((c) =>
          c.values.filter((v): v is string => typeof v === 'string' && v.startsWith('{')),
        )
        .map((json) => (JSON.parse(json) as { truncated?: boolean }).truncated === true);

    expect(metadataFlags(atCap).some(Boolean)).toBe(false);
    expect(metadataFlags(overCap).every(Boolean)).toBe(true);
  });

  it('reads no transcript and no tool content — only the events projection', async () => {
    const db = makeMockDb(readEvents(8));
    await processTrajectoryBatch(
      asDb(db),
      [
        {
          agent_type: 'CLAUDE_CODE',
          session_id: SESSION,
          shape_label: 'exploratory',
          tool_call_count: 8,
        },
      ],
      BASELINES,
    );
    for (const call of db.$queryRaw.mock.calls) {
      const { text } = introspect(call[0], call.slice(1));
      expect(text).not.toMatch(/transcript/i);
      expect(text).not.toMatch(/tool_input_bytes|prompt|content/i);
    }
  });
});

describe('loadStepBaselines', () => {
  it('excludes sessions below TRAJECTORY_MIN_TOOL_CALLS from the baseline population', async () => {
    const query = vi.fn(async (arg0: unknown, ...rest: unknown[]) => {
      const { text, values } = introspect(arg0, rest);
      expect(text).toMatch(/tool_call_count\s*>=/);
      expect(values).toContain(TRAJECTORY_MIN_TOOL_CALLS);
      return [];
    });
    await loadStepBaselines({
      // `$queryRaw` returns a `PrismaPromise<T>`, a branded generic no plain
      // async double can produce.
      $queryRaw: query as unknown as Parameters<typeof loadStepBaselines>[0]['$queryRaw'],
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('buildSubjectScoreInputs', () => {
  // A fixed clock, because the period is the row's identity (P13-013) and a
  // test that took `new Date()` would assert against a moving target.
  const asOf = new Date('2026-08-18T09:41:00Z');
  const skill = {
    distinct_users: 4n,
    downstream_calls: 100n,
    downstream_errors: 7n,
    invocations: 30n,
    kind: 'skill',
    name: 'deep-research',
    session_count: 12n,
  };
  const server = {
    calls: 200n,
    distinct_users: 6n,
    mcp_server: 'linear',
    session_count: 20n,
    tool_errors: 8n,
    unavailable: 2n,
  };

  it('keys skills by kind so a slash command and a skill of one name stay distinct', () => {
    const inputs = buildSubjectScoreInputs([skill, { ...skill, kind: 'slash' }], [], asOf);
    expect(inputs.map((i) => i.subjectId)).toEqual(['skill:deep-research', 'slash:deep-research']);
    expect(inputs.every((i) => i.scorerName === 'skill_effectiveness')).toBe(true);
  });

  it('emits the downstream error rate with its volumes in metadata', () => {
    const [row] = buildSubjectScoreInputs([skill], [], asOf);
    expect(row?.value).toBeCloseTo(0.07, 6);
    expect(row?.metadata).toMatchObject({ downstreamCalls: 100, downstreamErrors: 7 });
  });

  it('returns null rather than a rate below the call floor', () => {
    const [row] = buildSubjectScoreInputs(
      [{ ...skill, downstream_calls: 5n, downstream_errors: 1n }],
      [],
      asOf,
    );
    expect(row?.value).toBeNull();
  });

  it('sums both MCP failure kinds into the rate but keeps them separable', () => {
    const [row] = buildSubjectScoreInputs([], [server], asOf);
    expect(row?.scorerName).toBe('mcp_effectiveness');
    expect(row?.subjectId).toBe('linear');
    expect(row?.value).toBeCloseTo(10 / 200, 6);
    expect(row?.metadata).toMatchObject({ toolErrors: 8, unavailable: 2 });
  });

  it('buckets the period to the day, so two runs the same night are one row', () => {
    // The whole point of P13-013: `period_start` is the row's identity, so an
    // unbucketed `now()` would give every re-run its own row and turn the
    // idempotent upsert into an append.
    const morning = buildSubjectScoreInputs([skill], [], new Date('2026-08-18T02:03:04Z'));
    const evening = buildSubjectScoreInputs([skill], [], new Date('2026-08-18T23:59:59Z'));
    expect(morning[0]?.period?.start).toEqual(evening[0]?.period?.start);
    expect(morning[0]?.period?.end).toEqual(new Date('2026-08-18T00:00:00Z'));
    expect(morning[0]?.period?.start).toEqual(new Date('2026-07-19T00:00:00Z'));
  });

  it('starts a new row the next day, which is what makes it a series', () => {
    const today = buildSubjectScoreInputs([skill], [], new Date('2026-08-18T09:00:00Z'));
    const tomorrow = buildSubjectScoreInputs([skill], [], new Date('2026-08-19T09:00:00Z'));
    expect(today[0]?.period?.start).not.toEqual(tomorrow[0]?.period?.start);
  });

  it('gives every subject in one run the same period', () => {
    // Two subjects scored either side of midnight would otherwise land in
    // different series for the same nightly run.
    const inputs = buildSubjectScoreInputs([skill], [server], asOf);
    const starts = new Set(inputs.map((i) => i.period?.start?.toISOString()));
    expect(starts.size).toBe(1);
  });
});
