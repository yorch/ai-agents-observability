import type { Prisma } from '@ai-agents-observability/db';
import type { Event, PriceTable } from '@ai-agents-observability/schemas';
import { mergeRunKind } from '@ai-agents-observability/schemas';
import { describe, expect, it, vi } from 'vitest';

import { insertEventsBatch } from '../src/lib/insert-events';
import { upsertSessions } from '../src/lib/upsert-session';

/**
 * P13-002: a session's `run_kind` and its events' `run_kind` must not disagree.
 *
 * The bug these cover: `run_kind` was in the session INSERT's column list but
 * absent from `ON CONFLICT DO UPDATE SET`, and the per-batch aggregate took it
 * from whichever event happened to be first. A session whose opening batch
 * omitted the field was therefore pinned INTERACTIVE for its whole life while
 * every subsequent event said CI — so it stayed inside per-developer cost and
 * session counts forever, and no aggregate looked wrong enough to notice.
 */

const PRICE_TABLE: PriceTable = {
  generated_at: '2026-05-01T00:00:00+00:00',
  prices: {
    'claude-sonnet-4-6': {
      cache_read_per_mtok: 0.3,
      cache_write_per_mtok: 3.75,
      input_per_mtok: 3,
      output_per_mtok: 15,
    },
  },
  version: '1',
};

const PRICE_TABLES = {
  forAgentParam: () => PRICE_TABLE,
  resolve: () => PRICE_TABLE,
};

const SESSION_ID = '01906a44-0000-7000-8000-000000000000';
const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeEvent(
  eventId: string,
  runKind: 'interactive' | 'ci' | 'eval' | undefined,
  overrides: Partial<Event> = {},
): Event {
  return {
    agent_type: 'CLAUDE_CODE',
    client: { claude_code_version: '1.0.0', hostname_hash: 'sha256:abc', os: 'linux' },
    event_id: eventId,
    event_type: 'PostToolUse',
    metadata: {},
    redaction_flags: [],
    schema_version: 1,
    session_context: {
      cwd: '/runner/_work/app',
      git: null,
      is_resume: false,
      mode: 'normal',
      ...(runKind ? { run_kind: runKind } : {}),
    },
    session_id: SESSION_ID,
    ts: '2026-05-21T12:00:00Z',
    user_id_claim: USER_ID,
    ...overrides,
  };
}

type Captured = { params: unknown[]; sql: string };

/**
 * `settled` seeds the escalation probe: the session ids the database already
 * records as non-interactive. Empty by default, which is the first-claim case.
 */
function makeDb(settled: string[] = []) {
  const captured: Captured[] = [];
  return {
    $executeRaw: vi.fn(async (query: Prisma.Sql) => {
      captured.push({ params: [...query.values], sql: query.sql });
      return 1;
    }),
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      captured.push({ params: [...query.values], sql: query.sql });
      return settled.map((session_id) => ({ session_id }));
    }),
    captured,
  };
}

/** The session upsert, wherever it landed among the batch's statements. */
function sessionUpsert(db: ReturnType<typeof makeDb>): Captured | undefined {
  return db.captured.find((c) => c.sql.includes('INSERT INTO sessions'));
}

describe('mergeRunKind', () => {
  it('lets an explicit non-interactive claim win over a defaulted INTERACTIVE', () => {
    expect(mergeRunKind('INTERACTIVE', 'CI')).toBe('CI');
    expect(mergeRunKind('INTERACTIVE', 'EVAL')).toBe('EVAL');
  });

  it('is sticky: a later defaulted INTERACTIVE never promotes a run back', () => {
    // This is the direction that matters for the invariant — an event that simply
    // omitted run_kind arrives as INTERACTIVE and must not undo a real claim.
    expect(mergeRunKind('CI', 'INTERACTIVE')).toBe('CI');
    expect(mergeRunKind('EVAL', 'INTERACTIVE')).toBe('EVAL');
  });

  it('keeps the first claim when two non-interactive kinds disagree', () => {
    expect(mergeRunKind('CI', 'EVAL')).toBe('CI');
    expect(mergeRunKind('EVAL', 'CI')).toBe('EVAL');
  });

  it('is idempotent', () => {
    for (const k of ['INTERACTIVE', 'CI', 'EVAL'] as const) {
      expect(mergeRunKind(k, k)).toBe(k);
    }
  });
});

describe('upsertSessions run_kind', () => {
  it('folds a later CI claim in when the first event of the batch omitted it', async () => {
    const db = makeDb();
    await upsertSessions(
      db,
      [
        makeEvent('01906a44-0000-7000-8000-000000000001', undefined, {
          event_type: 'SessionStart',
        }),
        makeEvent('01906a44-0000-7000-8000-000000000002', 'ci'),
      ],
      USER_ID,
      new Map(),
      PRICE_TABLES,
    );

    const upsert = sessionUpsert(db);
    expect(upsert?.params).toContain('CI');
    expect(upsert?.params).not.toContain('INTERACTIVE');
  });

  it('does not let a defaulted INTERACTIVE event demote a CI batch', async () => {
    const db = makeDb();
    await upsertSessions(
      db,
      [
        makeEvent('01906a44-0000-7000-8000-000000000003', 'ci', { event_type: 'SessionStart' }),
        makeEvent('01906a44-0000-7000-8000-000000000004', undefined),
      ],
      USER_ID,
      new Map(),
      PRICE_TABLES,
    );

    expect(sessionUpsert(db)?.params).toContain('CI');
  });

  it('updates run_kind on conflict, and only away from INTERACTIVE', async () => {
    const db = makeDb();
    await upsertSessions(
      db,
      [makeEvent('01906a44-0000-7000-8000-000000000005', 'ci')],
      USER_ID,
      new Map(),
      PRICE_TABLES,
    );

    const sql = sessionUpsert(db)?.sql ?? '';
    const onConflict = sql.slice(sql.indexOf('ON CONFLICT'));
    // The whole bug: run_kind was in the INSERT list but not in DO UPDATE SET.
    expect(onConflict).toMatch(/run_kind\s*=/);
    // ...and it must be the asymmetric rule, not a blind overwrite.
    expect(onConflict).toMatch(/WHEN sessions\.run_kind = 'INTERACTIVE'/);
    expect(onConflict).toMatch(/ELSE sessions\.run_kind/);
  });

  it('reconciles already-written events when a session turns out non-interactive', async () => {
    const db = makeDb();
    await upsertSessions(
      db,
      [makeEvent('01906a44-0000-7000-8000-000000000006', 'eval')],
      USER_ID,
      new Map(),
      PRICE_TABLES,
    );

    const reconcile = db.captured.find((c) => c.sql.includes('UPDATE events'));
    expect(reconcile).toBeDefined();
    expect(reconcile?.params).toContain(SESSION_ID);
  });

  it('skips the reconciliation for a later batch of an already-escalated session', async () => {
    // The claim is not news: the session has been recorded as EVAL since its
    // first batch, so its events were reconciled then. Re-running the fixup here
    // would re-scan a window that grows with the session on every single batch.
    const db = makeDb([SESSION_ID]);
    await upsertSessions(
      db,
      [makeEvent('01906a44-0000-7000-8000-00000000000b', 'eval')],
      USER_ID,
      new Map(),
      PRICE_TABLES,
    );

    expect(db.captured.some((c) => c.sql.includes('UPDATE events'))).toBe(false);
    // ...but the session upsert still ran, so the row itself stays correct.
    expect(sessionUpsert(db)).toBeDefined();
  });

  it('skips the reconciliation entirely for an ordinary interactive batch', async () => {
    const db = makeDb();
    await upsertSessions(
      db,
      [makeEvent('01906a44-0000-7000-8000-000000000007', 'interactive')],
      USER_ID,
      new Map(),
      PRICE_TABLES,
    );

    expect(db.captured.some((c) => c.sql.includes('UPDATE events'))).toBe(false);
    // Not even the probe: the common path costs one statement, as before.
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('insertEventsBatch run_kind', () => {
  it('writes one merged run_kind for every event of a session in the batch', async () => {
    const db = makeDb();
    await insertEventsBatch(
      db,
      [
        makeEvent('01906a44-0000-7000-8000-000000000008', undefined, {
          event_type: 'SessionStart',
        }),
        makeEvent('01906a44-0000-7000-8000-000000000009', 'ci'),
        makeEvent('01906a44-0000-7000-8000-00000000000a', undefined),
      ],
      USER_ID,
      PRICE_TABLES,
    );

    // Three events, all of one session: every row must carry CI, or the events
    // hypertable — which most read paths query without joining sessions — would
    // hold a split population for a single session and no join would reveal it.
    const params = db.captured[0]?.params ?? [];
    expect(params.filter((p) => p === 'CI')).toHaveLength(3);
    expect(params).not.toContain('INTERACTIVE');
  });

  it('keeps distinct sessions in a mixed batch independent', async () => {
    const other = '01906a44-0000-7000-8000-0000000000ff';
    const db = makeDb();
    await insertEventsBatch(
      db,
      [
        makeEvent('01906a44-0000-7000-8000-00000000000b', 'ci'),
        makeEvent('01906a44-0000-7000-8000-00000000000c', undefined, { session_id: other }),
      ],
      USER_ID,
      PRICE_TABLES,
    );

    const params = db.captured[0]?.params ?? [];
    expect(params.filter((p) => p === 'CI')).toHaveLength(1);
    expect(params.filter((p) => p === 'INTERACTIVE')).toHaveLength(1);
  });
});
