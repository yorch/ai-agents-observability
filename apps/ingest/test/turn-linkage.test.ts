import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// Mock the db package so this file imports without the generated Prisma client.
// The job only uses Prisma.sql / Prisma.join (tagged templates).
vi.mock('@ai-agents-observability/db', () => ({
  Prisma: {
    join: (parts: unknown[], sep: string) => ({ sep, strings: [], values: parts }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

import { runLinkTurnEvents } from '../src/jobs/link-turn-events';
import {
  issuedToolUseIds,
  linkageForSession,
  TOOL_USE_IDS_METADATA_KEY,
} from '../src/lib/turn-linkage';

const SESSION = '00000000-0000-4000-8000-00000000a001';
const OTHER_SESSION = '00000000-0000-4000-8000-00000000a002';
const DAY_START = new Date('2026-08-20T00:00:00Z');
const DAY_END = new Date('2026-08-21T00:00:00Z');
const at = (m: number) => new Date(DAY_START.getTime() + m * 60_000);

// ── The definition, tested without a database ────────────────────────────────

describe('issuedToolUseIds', () => {
  it('reads the array the hook writes', () => {
    expect(issuedToolUseIds({ source: 'claude-jsonl', tool_use_ids: ['a', 'b'] })).toEqual([
      'a',
      'b',
    ]);
  });

  it('yields nothing for metadata that has no such key', () => {
    // A hook older than P14-006, or any other agent's Stop. This is the ordinary
    // case, not an error — the turn simply links nothing.
    expect(issuedToolUseIds({ source: 'claude-jsonl' })).toEqual([]);
  });

  it('yields nothing for shapes a hostile or broken writer could produce', () => {
    // This value crossed a process boundary from a binary on a developer's
    // machine. Every one of these must degrade to "linked nothing", never throw
    // and never produce a link.
    expect(issuedToolUseIds(null)).toEqual([]);
    expect(issuedToolUseIds(undefined)).toEqual([]);
    expect(issuedToolUseIds('tool_use_ids')).toEqual([]);
    expect(issuedToolUseIds(['a'])).toEqual([]);
    expect(issuedToolUseIds({ tool_use_ids: 'a' })).toEqual([]);
    expect(issuedToolUseIds({ tool_use_ids: { 0: 'a' } })).toEqual([]);
  });

  it('drops non-string and empty entries but keeps the rest', () => {
    expect(issuedToolUseIds({ tool_use_ids: ['a', '', 7, null, 'b'] })).toEqual(['a', 'b']);
  });
});

const stop = (turn: number, ids: string[]) => ({
  eventId: `stop-${turn}`,
  metadata: { [TOOL_USE_IDS_METADATA_KEY]: ids, source: 'claude-jsonl' },
  turnNumber: turn,
});

const tool = (id: string, minute: number) => ({
  eventId: `ev-${id}`,
  toolUseId: id,
  ts: at(minute),
});

describe('linkageForSession', () => {
  it('points each tool at the turn whose Stop claimed its id', () => {
    const { rows, unresolved } = linkageForSession(
      [stop(1, ['toolu_1', 'toolu_2']), stop(2, ['toolu_3'])],
      [tool('toolu_1', 1), tool('toolu_2', 2), tool('toolu_3', 3)],
    );
    expect(unresolved).toBe(0);
    expect(rows.map((r) => [r.eventId, r.turnNumber, r.parentEventId])).toEqual([
      ['ev-toolu_1', 1, 'stop-1'],
      ['ev-toolu_2', 1, 'stop-1'],
      ['ev-toolu_3', 2, 'stop-2'],
    ]);
  });

  it('places parallel calls in the SAME turn regardless of their timestamps', () => {
    // The exact failure mode the rejected ts-nearest-Stop heuristic had: two
    // calls issued by one turn, one of them finishing after the next turn began.
    const { rows } = linkageForSession(
      [stop(1, ['toolu_fast', 'toolu_slow']), stop(2, ['toolu_next'])],
      [tool('toolu_fast', 1), tool('toolu_next', 2), tool('toolu_slow', 99)],
    );
    expect(rows.map((r) => [r.eventId, r.turnNumber])).toEqual([
      ['ev-toolu_fast', 1],
      ['ev-toolu_next', 2],
      ['ev-toolu_slow', 1],
    ]);
  });

  it('leaves a tool whose issuing turn is absent unlinked, and counts it', () => {
    const { rows, unresolved } = linkageForSession(
      [stop(1, ['toolu_1'])],
      [tool('toolu_1', 1), tool('toolu_orphan', 2)],
    );
    expect(rows.map((r) => r.eventId)).toEqual(['ev-toolu_1']);
    expect(unresolved).toBe(1);
  });

  it('links nothing at all when no Stop carries the key', () => {
    const { rows, unresolved } = linkageForSession(
      [{ eventId: 'stop-1', metadata: { source: 'claude-jsonl' }, turnNumber: 1 }],
      [tool('toolu_1', 1)],
    );
    expect(rows).toEqual([]);
    expect(unresolved).toBe(1);
  });

  it('resolves a contested id deterministically — first claim wins', () => {
    const { rows } = linkageForSession(
      [stop(1, ['toolu_1']), stop(2, ['toolu_1'])],
      [tool('toolu_1', 1)],
    );
    expect(rows[0]?.turnNumber).toBe(1);
  });
});

// ── The cross-workspace contract ─────────────────────────────────────────────

describe('the metadata key agrees with the hook that writes it', () => {
  it('matches TOOL_USE_IDS_METADATA_KEY in apps/hook/src/lib/claude-turns.ts', () => {
    // Ingest cannot import from the hook — it is a compiled CLI, not a
    // dependency of this app — so the key is restated in src/lib/turn-linkage.ts.
    // This reads the hook's source as TEXT so the duplication cannot drift: a
    // rename on either side leaves the join silently matching nothing, and
    // nothing else in either suite would notice.
    const source = readFileSync(
      join(import.meta.dirname, '../../hook/src/lib/claude-turns.ts'),
      'utf8',
    );
    const match = /TOOL_USE_IDS_METADATA_KEY\s*=\s*'([^']+)'/.exec(source);
    expect(match?.[1]).toBe(TOOL_USE_IDS_METADATA_KEY);
  });
});

// ── The job ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function sqlText(arg: unknown): string {
  const s = arg as { strings?: string[] };
  return Array.isArray(s.strings) ? s.strings.join(' ') : String(arg);
}

function makeDb(
  opts: { compressed?: boolean; sessions?: Row[]; stops?: Row[]; tools?: Row[] } = {},
) {
  const executed: string[] = [];
  const writes: unknown[] = [];
  const db = {
    _executed: executed,
    _writes: writes,
    $executeRaw: vi.fn(async (arg: unknown) => {
      executed.push(sqlText(arg));
      writes.push(arg);
      return 1;
    }),
    $queryRaw: vi.fn(async (arg: unknown) => {
      const text = sqlText(arg);
      executed.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        return [{ pg_try_advisory_lock: true }];
      }
      if (text.includes('pg_advisory_unlock')) {
        return [{ pg_advisory_unlock: true }];
      }
      if (text.includes('timescaledb_information.chunks')) {
        return [
          {
            chunk_name: '_hyper_1_1_chunk',
            chunk_schema: '_timescaledb_internal',
            is_compressed: opts.compressed === true,
            range_end: DAY_END,
            range_start: DAY_START,
          },
        ];
      }
      if (text.includes('decompress_chunk') || text.includes('compress_chunk')) {
        return [{}];
      }
      if (text.includes('FROM sessions')) {
        return opts.sessions ?? [{ ended_at: at(120), session_id: SESSION, started_at: DAY_START }];
      }
      if (text.includes("event_type = 'Stop'")) {
        return opts.stops ?? [];
      }
      if (text.includes('tool_use_id IS NOT NULL')) {
        return opts.tools ?? [];
      }
      return [];
    }),
    jobRun: {
      create: vi.fn(async () => ({ id: 1n })),
      update: vi.fn(async () => ({})),
    },
  };
  return db;
}

const stopRow = (turn: number, ids: string[], session = SESSION) => ({
  event_id: `stop-${turn}`,
  metadata: { source: 'claude-jsonl', tool_use_ids: ids },
  session_id: session,
  turn_number: turn,
});

const toolRow = (id: string, minute: number, session = SESSION) => ({
  event_id: `ev-${id}`,
  session_id: session,
  tool_use_id: id,
  ts: at(minute),
});

const run = (db: ReturnType<typeof makeDb>) =>
  runLinkTurnEvents(db as unknown as Parameters<typeof runLinkTurnEvents>[0], {
    now: new Date('2026-08-21T06:10:00Z'),
  });

describe('runLinkTurnEvents', () => {
  it('writes the resolved linkage back onto the tool rows', async () => {
    const db = makeDb({
      stops: [stopRow(1, ['toolu_1', 'toolu_2']), stopRow(2, ['toolu_3'])],
      tools: [toolRow('toolu_1', 1), toolRow('toolu_2', 2), toolRow('toolu_3', 3)],
    });
    await run(db);

    const update = db._executed.find((s) => s.includes('UPDATE events'));
    expect(update).toBeDefined();
    expect(update).toContain('SET turn_number');
    expect(update).toContain('parent_event_id');
    expect(db._writes).toHaveLength(1);
  });

  it('never overwrites a linkage that was captured rather than derived', async () => {
    // Belt AND braces: the read selects only `turn_number IS NULL`, and the
    // write repeats it. An imported session's rows must survive a run of this
    // job untouched even if the two raced.
    const db = makeDb({
      stops: [stopRow(1, ['toolu_1'])],
      tools: [toolRow('toolu_1', 1)],
    });
    await run(db);

    const read = db._executed.find((s) => s.includes('tool_use_id IS NOT NULL'));
    expect(read).toContain('turn_number IS NULL');
    const update = db._executed.find((s) => s.includes('UPDATE events'));
    expect(update).toContain('e.turn_number IS NULL');
  });

  it('touches nothing but the two linkage columns', async () => {
    // The money columns are not this job's to move. sessions.total_cost_usd,
    // pr_rollups and the caggs already count these dollars once, at the Stop.
    const db = makeDb({
      stops: [stopRow(1, ['toolu_1'])],
      tools: [toolRow('toolu_1', 1)],
    });
    await run(db);

    for (const statement of db._executed) {
      expect(statement).not.toContain('total_cost_usd');
      expect(statement).not.toContain('attributed_cost_usd');
      expect(statement).not.toContain('pr_rollups');
      expect(statement).not.toContain('UPDATE sessions');
    }
  });

  it('writes nothing when every tool row is already linked', async () => {
    const db = makeDb({ stops: [stopRow(1, ['toolu_1'])], tools: [] });
    await run(db);
    expect(db._writes).toHaveLength(0);
    // …and does not even ask for the Stop rows it would have joined against.
    expect(db._executed.some((s) => s.includes("event_type = 'Stop'"))).toBe(false);
  });

  it('writes nothing when no Stop claims the ids', async () => {
    const db = makeDb({ stops: [], tools: [toolRow('toolu_1', 1)] });
    await run(db);
    expect(db._writes).toHaveLength(0);
  });

  it('does no work at all when the window holds no settled session', async () => {
    const db = makeDb({ sessions: [] });
    await run(db);
    expect(db._writes).toHaveLength(0);
    expect(db._executed.some((s) => s.includes('FROM events'))).toBe(false);
  });

  it('keeps two sessions’ ids apart', async () => {
    // tool_use_ids are unique per session by construction, but the join must be
    // scoped anyway — a collision across sessions would attribute one user's
    // dollars to another's turn.
    const db = makeDb({
      sessions: [
        { ended_at: at(120), session_id: SESSION, started_at: DAY_START },
        { ended_at: at(130), session_id: OTHER_SESSION, started_at: DAY_START },
      ],
      stops: [stopRow(1, ['toolu_dup'], SESSION)],
      tools: [toolRow('toolu_dup', 1, SESSION), toolRow('toolu_dup', 2, OTHER_SESSION)],
    });
    await run(db);

    // Exactly ONE row is written — the one whose own session's Stop claimed the
    // id. The other session has no Stop naming it, so it stays NULL.
    const rowsWritten = (
      (db._writes[0] as { values: unknown[] }).values.find(
        (v): v is { values: unknown[] } =>
          typeof v === 'object' && v !== null && Array.isArray((v as { values?: unknown }).values),
      ) as { values: unknown[] } | undefined
    )?.values;
    expect(rowsWritten).toHaveLength(1);
    expect(JSON.stringify(rowsWritten)).toContain('ev-toolu_dup');
  });

  it('decompresses a compressed chunk and recompresses it afterwards', async () => {
    const db = makeDb({
      compressed: true,
      stops: [stopRow(1, ['toolu_1'])],
      tools: [toolRow('toolu_1', 1)],
    });
    await run(db);

    const order = db._executed.filter(
      (s) =>
        s.includes('decompress_chunk') ||
        s.includes('UPDATE events') ||
        s.includes('compress_chunk'),
    );
    expect(order[0]).toContain('decompress_chunk');
    expect(order.at(-1)).toContain('compress_chunk');
  });

  it('records a job_runs row under its own name, so its lock is its own', async () => {
    const db = makeDb({ stops: [stopRow(1, ['toolu_1'])], tools: [toolRow('toolu_1', 1)] });
    await run(db);
    expect(db.jobRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jobName: 'link-turn-events' }) }),
    );
  });
});
