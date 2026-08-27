import type { Prisma } from '@ai-agents-observability/db';
import type { Event, PriceTable } from '@ai-agents-observability/schemas';
import { describe, expect, it, vi } from 'vitest';

import { insertEventsBatch } from '../src/lib/insert-events';

type InsertEventsDb = Parameters<typeof insertEventsBatch>[0];

/**
 * The server-side half of P14-008.
 *
 * Capture is fixed in `apps/hook`, but the hook is a binary developers install
 * and upgrade on their own schedule: a server running the fix still receives the
 * pre-fix payload shape from every machine that has not upgraded, for as long as
 * those machines run. `insertEventsBatch` is the last point an operator controls
 * before the value becomes a durable, unredacted JSONB row, so it strips
 * content-bearing keys on the way in.
 *
 * The second assertion is the one that keeps the strip from being a cure worse
 * than the disease: only the NAME rule applies here. The hook's shape rule refuses
 * arrays, and `metadata.tool_use_ids` — the array the P14-006 turn-linkage join
 * reads — is a legitimate DERIVED value written by our own producers. Applying the
 * shape rule server-side would silently delete it and break cost attribution.
 */

const PRICE_TABLE: PriceTable = {
  generated_at: '2026-05-01T00:00:00+00:00',
  prices: {},
  version: '1',
};

const PRICE_TABLES = { forAgentParam: () => PRICE_TABLE, resolve: () => PRICE_TABLE };

const SESSION_ID = '01906a44-0000-7000-8000-000000000000';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const PROSE = 'I refactored the auth module and removed the legacy cookie path.';

function stopEvent(metadata: Record<string, unknown>): Event {
  return {
    agent_type: 'CLAUDE_CODE',
    client: { claude_code_version: '1.0.0', hostname_hash: 'sha256:abc', os: 'linux' },
    event_id: '01906a44-0000-7000-8000-0000000000aa',
    event_type: 'Stop',
    metadata,
    redaction_flags: [],
    schema_version: 1,
    session_context: { cwd: '/repo', git: null, is_resume: false, mode: 'normal' },
    session_id: SESSION_ID,
    ts: '2026-05-21T12:00:00Z',
    user_id_claim: USER_ID,
  };
}

function makeDb() {
  const captured: { params: unknown[]; sql: string }[] = [];
  return {
    // `$queryRaw` is generic in its row type (`<T>(q) => Promise<T>`) — a
    // signature no concrete double can implement.
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      captured.push({ params: [...query.values], sql: query.sql });
      return [];
    }) as unknown as InsertEventsDb['$queryRaw'],
    captured,
  };
}

/** The metadata JSON string this batch would have written, parsed back. */
async function insertedMetadata(metadata: Record<string, unknown>): Promise<unknown> {
  const db = makeDb();
  await insertEventsBatch(db, [stopEvent(metadata)], USER_ID, PRICE_TABLES);
  const insert = db.captured.find((c) => c.sql.includes('INSERT INTO events'));
  const json = insert?.params.find(
    (p): p is string => typeof p === 'string' && p.startsWith('{') && p.endsWith('}'),
  );
  expect(json).toBeDefined();
  return JSON.parse(json as string);
}

describe('insertEventsBatch strips content-bearing metadata keys', () => {
  it('drops assistant prose sent by a pre-fix hook binary', async () => {
    const written = await insertedMetadata({
      last_assistant_message: PROSE,
      source: 'claude-jsonl',
    });
    expect(written).toEqual({ source: 'claude-jsonl' });
  });

  it('keeps the derived tool_use_ids array the turn-linkage join reads', async () => {
    const written = await insertedMetadata({
      prompt: PROSE,
      source: 'claude-jsonl',
      tool_use_ids: ['toolu_01', 'toolu_02'],
    });
    expect(written).toEqual({ source: 'claude-jsonl', tool_use_ids: ['toolu_01', 'toolu_02'] });
  });
});
