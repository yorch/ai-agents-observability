import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitDeferred, discardDeferred, resetDeferred } from '../lib/deferred-commit';
import { agentStateDir } from '../lib/paths';
import { claudeCodeAdapter } from './claude-code';
import { conformanceErrors } from './conformance';
import type { ConformantEvent } from './index';

// Per-turn usage capture on the LIVE Claude Code path (P14-003).
//
// Before this, Claude Code's hook payload carried no token usage on any hook, so
// a live-captured session recorded $0 forever. The usage is read from the
// transcript the Stop payload already points at, incrementally, and folded onto
// one Stop event per assistant turn.
//
// Model ids are copied from apps/ingest/src/data/price-table.claude_code.v1.json
// — a plausible-but-nonexistent model prices at $0, which is the failure this
// whole task exists to fix (see apps/hook/AGENTS.md).
const MODEL = 'claude-opus-4-5-20251101';
const SESSION_ID = '3f8c2a1e-9d47-4b6a-8c25-1e7f0a9b4d63';

let home: string;
let transcript: string;

function assistantLine(
  uuid: string,
  ts: string,
  usage: Record<string, number> | null,
  toolUse?: { id: string; name: string },
): string {
  const content: unknown[] = [{ text: 'working on it', type: 'text' }];
  if (toolUse) {
    content.push({
      id: toolUse.id,
      input: { command: 'ls' },
      name: toolUse.name,
      type: 'tool_use',
    });
  }
  return `${JSON.stringify({
    cwd: '/home/dev/proj',
    message: { content, model: MODEL, role: 'assistant', ...(usage ? { usage } : {}) },
    sessionId: SESSION_ID,
    timestamp: ts,
    type: 'assistant',
    uuid,
  })}\n`;
}

function userLine(uuid: string, ts: string): string {
  return `${JSON.stringify({
    cwd: '/home/dev/proj',
    message: { content: 'do the thing', role: 'user' },
    sessionId: SESSION_ID,
    timestamp: ts,
    type: 'user',
    uuid,
  })}\n`;
}

const USAGE = {
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 12_000,
  input_tokens: 1500,
  output_tokens: 420,
};

function stopPayload(path: string = transcript): Record<string, unknown> {
  return {
    cwd: '/home/dev/proj',
    hook_event_name: 'Stop',
    session_id: SESSION_ID,
    transcript_path: path,
  };
}

/**
 * One Stop, all the way through a SUCCESSFUL enqueue.
 *
 * The cursor commit is no longer part of the mapping: the adapter registers it
 * and `hook-entry` runs it only after the events are queued (see
 * lib/deferred-commit.ts). Calling `mapBatch` alone therefore leaves the cursor
 * where it was, so a helper that stopped there would model a pipeline that never
 * commits and every incremental-read assertion below would be meaningless.
 * `batchWithoutCommit` covers the other half.
 */
function batch(payload = stopPayload()) {
  const events = claudeCodeAdapter.mapBatch?.('stop', payload) ?? null;
  commitDeferred();
  return events;
}

/** One Stop whose events never reached the queue — the cursor must not move. */
function batchWithoutCommit(payload = stopPayload()) {
  const events = claudeCodeAdapter.mapBatch?.('stop', payload) ?? null;
  discardDeferred('test: enqueue failed');
  return events;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-usage-test-'));
  process.env.AIOT_HOME = home;
  transcript = join(home, 'session.jsonl');
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
  process.env.AIOT_HOME = undefined;
});

// Deferred commits are module state (lib/deferred-commit.ts). A test that maps a
// batch without committing or discarding leaves work pending, which a LATER test
// could then run — against a temp dir that beforeEach has already replaced. Clear
// it per test so the suite cannot depend on file order.
beforeEach(resetDeferred);

describe('claudeCodeAdapter per-turn usage', () => {
  it('folds a turn’s token usage onto a schema-conformant Stop event', () => {
    writeFileSync(
      transcript,
      userLine('u1', '2026-08-20T10:00:00.000Z') +
        assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE),
    );

    const events = batch();
    expect(events).toHaveLength(1);
    const stop = events?.[0];
    expect(conformanceErrors(stop)).toEqual([]);
    expect(stop?.event_type).toBe('Stop');
    expect(stop?.llm).toEqual({
      cache_creation_tokens: 300,
      cache_read_tokens: 12_000,
      // Adapters never price; ingest recomputes from the price table (DESIGN_DOC §6.7).
      cost_usd: 0,
      // Anthropic's counts are already disjoint — input_tokens must be passed
      // through unchanged, NOT reduced by the cache counters.
      input_tokens: 1500,
      model: MODEL,
      output_tokens: 420,
    });
    // The Stop takes the transcript entry's own timestamp, not the hook's clock.
    expect(stop?.ts).toBe('2026-08-20T10:00:05.000Z');
  });

  it('emits one Stop per assistant turn, numbered 1-based and monotonically', () => {
    writeFileSync(
      transcript,
      userLine('u1', '2026-08-20T10:00:00.000Z') +
        assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE) +
        assistantLine('a2', '2026-08-20T10:00:09.000Z', USAGE) +
        assistantLine('a3', '2026-08-20T10:00:12.000Z', USAGE),
    );

    const events = batch();
    expect(events?.map((e) => e.turn_number)).toEqual([1, 2, 3]);
    expect(new Set(events?.map((e) => e.event_id)).size).toBe(3);
  });

  it('leaves parent_event_id null on the Stop itself', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    expect(batch()?.[0]?.parent_event_id ?? null).toBeNull();
  });

  it('carries no llm block for a turn that reported no usage', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', null));
    const stop = batch()?.[0];
    expect(stop?.turn_number).toBe(1);
    expect(stop?.llm ?? null).toBeNull();
    expect(conformanceErrors(stop)).toEqual([]);
  });

  it('treats an all-zero usage block as no usage rather than a $0 turn', () => {
    writeFileSync(
      transcript,
      assistantLine('a1', '2026-08-20T10:00:05.000Z', {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      }),
    );
    expect(batch()?.[0]?.llm ?? null).toBeNull();
  });
});

describe('claudeCodeAdapter incremental transcript read', () => {
  it('reads only what is new on the second Stop and never re-attributes usage', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    const first = batch();
    expect(first?.map((e) => e.turn_number)).toEqual([1]);

    // Turn two is appended; the second Stop must see ONLY it.
    writeFileSync(
      transcript,
      assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE) +
        assistantLine('a2', '2026-08-20T10:00:20.000Z', USAGE),
    );
    const second = batch();
    expect(second).toHaveLength(1);
    expect(second?.[0]?.turn_number).toBe(2);
    expect(second?.[0]?.event_id).not.toBe(first?.[0]?.event_id);
  });

  it('does NOT advance the cursor when the events never reach the queue', () => {
    // The bug this whole change exists for. `hook-entry` builds the events and
    // only then opens the queue and enqueues; both can fail (full disk, locked
    // or corrupt queue.db) and both only log. When the cursor advanced during
    // the build, those turns were unreadable forever after — and they carry the
    // `llm` block that is the only live source of Claude Code token usage, so
    // sessions.total_cost_usd stayed permanently low with nothing to say so.
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));

    const dropped = batchWithoutCommit();
    expect(dropped?.map((e) => e.turn_number)).toEqual([1]);

    // The same turn must still be readable, with the SAME event id — the ids are
    // derived from the transcript entry, so a recovered turn dedupes against a
    // later `aiot import` rather than double-counting.
    const retried = batch();
    expect(retried?.map((e) => e.turn_number)).toEqual([1]);
    expect(retried?.[0]?.event_id).toBe(dropped?.[0]?.event_id as string);
    expect(retried?.[0]?.llm?.input_tokens).toBe(1500);

    // And once committed it does not come back a third time.
    expect(batch()).toBeNull();
  });

  it('falls back to the plain single Stop when nothing new was appended', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    expect(batch()).toHaveLength(1);
    // null = "no batch", which hook-entry turns into the ordinary Stop event, so
    // the session's end signal survives a turn with no new transcript entries.
    expect(batch()).toBeNull();
  });

  it('ignores a half-written final line until it is complete', () => {
    const complete = assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE);
    writeFileSync(transcript, `${complete}{"type":"assistant","uuid":"a2","mess`);
    expect(batch()?.map((e) => e.turn_number)).toEqual([1]);

    writeFileSync(transcript, complete + assistantLine('a2', '2026-08-20T10:00:20.000Z', USAGE));
    expect(batch()?.map((e) => e.turn_number)).toEqual([2]);
  });

  it('restarts numbering when the session’s transcript path changes', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    expect(batch()?.[0]?.turn_number).toBe(1);

    // A cursor offset is only meaningful against the file it was measured in, and
    // the ordinal is an ordinal WITHIN that file.
    const other = join(home, 'other.jsonl');
    writeFileSync(other, assistantLine('b1', '2026-08-20T11:00:00.000Z', USAGE));
    expect(batch(stopPayload(other))?.[0]?.turn_number).toBe(1);
  });
});

describe('claudeCodeAdapter usage read degrades instead of throwing', () => {
  // The always-exit-0 rule applied to money: an unreadable transcript costs the
  // turn its usage, never the turn itself. Every case returns null so hook-entry
  // falls back to the ordinary Stop.
  it('returns null when the transcript file does not exist', () => {
    expect(() => batch(stopPayload(join(home, 'missing.jsonl')))).not.toThrow();
    expect(batch(stopPayload(join(home, 'missing.jsonl')))).toBeNull();
  });

  it('returns null when the payload carries no transcript_path', () => {
    const payload = stopPayload();
    payload.transcript_path = undefined;
    expect(batch(payload)).toBeNull();
  });

  it('returns null when the session id is unusable', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    const payload = stopPayload();
    payload.session_id = '';
    // A nil session id would make every unknown session share one cursor file.
    expect(batch(payload)).toBeNull();
  });

  it('returns null when the transcript is a directory, not a file', () => {
    const dir = join(home, 'not-a-file');
    mkdirSync(dir);
    expect(() => batch(stopPayload(dir))).not.toThrow();
    expect(batch(stopPayload(dir))).toBeNull();
  });

  it('returns null when the transcript cannot be opened', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    chmodSync(transcript, 0o000);
    try {
      expect(() => batch()).not.toThrow();
      expect(batch()).toBeNull();
    } finally {
      chmodSync(transcript, 0o600);
    }
  });

  it('skips malformed lines and still emits the turns around them', () => {
    writeFileSync(
      transcript,
      assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE) +
        '{ not json at all\n' +
        '\n' +
        assistantLine('a2', '2026-08-20T10:00:20.000Z', USAGE),
    );
    const events = batch();
    // The malformed line does NOT advance the ordinal — import skips it the same
    // way, so both paths agree that these are turns 1 and 2.
    expect(events?.map((e) => e.turn_number)).toEqual([1, 2]);
  });

  it('survives a usage block whose counts are not numbers', () => {
    writeFileSync(
      transcript,
      `${JSON.stringify({
        message: {
          content: [],
          model: MODEL,
          role: 'assistant',
          usage: { input_tokens: 'lots', output_tokens: null },
        },
        timestamp: '2026-08-20T10:00:05.000Z',
        type: 'assistant',
        uuid: 'a1',
      })}\n`,
    );
    const stop = batch()?.[0];
    expect(stop?.llm ?? null).toBeNull();
    expect(conformanceErrors(stop)).toEqual([]);
  });

  it('only expands the stop hook', () => {
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    // SubagentStop reads no transcript: subagent turns are sidechain entries in
    // the SAME file, so the main Stop's incremental read already covers them.
    expect(claudeCodeAdapter.mapBatch?.('subagent-stop', stopPayload()) ?? null).toBeNull();
    expect(claudeCodeAdapter.mapBatch?.('pre-tool-use', stopPayload()) ?? null).toBeNull();
  });
});

// The usage for the turns after a session's last Stop, read at SessionEnd. It is
// bulk work behind the SessionEnd's own event (HookAdapter.tail): chunked, with a
// cursor that is exact after every chunk, so a kill, a full queue or the hook's
// deadline lose nothing that a later Stop, SessionEnd or import cannot read.
describe('claudeCodeAdapter SessionEnd tail', () => {
  const T2 = { ...USAGE, input_tokens: 2100, output_tokens: 640 };
  const T3 = { ...USAGE, cache_read_input_tokens: 15_500, input_tokens: 90, output_tokens: 77 };

  function sessionEndPayload(path: string = transcript): Record<string, unknown> {
    return {
      cwd: '/home/dev/proj',
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
      session_id: SESSION_ID,
      transcript_path: path,
    };
  }

  /** What hook-entry does: pull chunks, queue them (here: collect), commit each. */
  function runTail(
    opts: { chunkSize?: number; stopAfterChunks?: number; commit?: boolean } = {},
    payload = sessionEndPayload(),
  ) {
    const chunks: { events: ConformantEvent[]; commit(): void }[] = [];
    const gen = claudeCodeAdapter.tail?.('session-end', payload, {
      chunkSize: opts.chunkSize ?? 500,
      shouldStop: () => chunks.length >= (opts.stopAfterChunks ?? Number.POSITIVE_INFINITY),
    });
    for (const chunk of gen ?? []) {
      chunks.push(chunk);
      if (opts.commit !== false) {
        chunk.commit();
      }
    }
    return { chunks, events: chunks.flatMap((c) => c.events) };
  }

  const cursor = () =>
    JSON.parse(readFileSync(join(agentStateDir('claude-code'), `${SESSION_ID}.json`), 'utf8')) as {
      offset: number;
      path: string;
      turns: number;
    };

  function sessionWithTailAfterLastStop(): void {
    writeFileSync(
      transcript,
      userLine('u1', '2026-08-20T10:00:00.000Z') +
        assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE, {
          id: 'toolu_01A09q90qw90lq917835lq9',
          name: 'Bash',
        }),
    );
    expect(batch()).toHaveLength(1); // the Stop
    writeFileSync(
      transcript,
      readFileSync(transcript, 'utf8') +
        userLine('u2', '2026-08-20T10:01:00.000Z') +
        assistantLine('a2', '2026-08-20T10:01:06.000Z', T2) +
        assistantLine('a3', '2026-08-20T10:01:12.000Z', T3, {
          id: 'toolu_01B7XnkR3wQm2sLzH8yTqPaV',
          name: 'Read',
        }),
    );
  }

  it('mapBatch reads nothing at SessionEnd: the plain event is the primary one', () => {
    sessionWithTailAfterLastStop();
    expect(claudeCodeAdapter.mapBatch?.('session-end', sessionEndPayload()) ?? null).toBeNull();
    expect(existsSync(join(agentStateDir('claude-code'), `${SESSION_ID}.json`))).toBe(true); // the Stop's
    expect(cursor().turns).toBe(1); // untouched
  });

  it('yields the turns after the last Stop as conformant Stop events with tokens', () => {
    sessionWithTailAfterLastStop();
    const { events } = runTail();
    expect(events.map((e) => [e.event_type, e.turn_number])).toEqual([
      ['Stop', 2],
      ['Stop', 3],
    ]);
    for (const e of events) {
      expect(conformanceErrors(e)).toEqual([]);
    }
    expect(events[0]?.llm).toEqual({
      cache_creation_tokens: 300,
      cache_read_tokens: 12_000,
      cost_usd: 0, // adapters never price; ingest does
      input_tokens: 2100,
      model: MODEL,
      output_tokens: 640,
    });
    expect(events[1]?.llm).toMatchObject({
      cache_read_tokens: 15_500,
      input_tokens: 90,
      output_tokens: 77,
    });
    expect(events[1]?.metadata).toMatchObject({
      source: 'claude-jsonl',
      tool_use_ids: ['toolu_01B7XnkR3wQm2sLzH8yTqPaV'],
    });
  });

  it('Stop then SessionEnd counts every turn once, in either order', () => {
    sessionWithTailAfterLastStop();
    const first = runTail();
    expect(first.events).toHaveLength(2);
    expect(runTail().chunks).toHaveLength(0); // the cursor is at the end: nothing to yield
    expect(batch()).toBeNull(); // and a Stop after it finds nothing new either
    expect(cursor()).toEqual({ offset: statSync(transcript).size, path: transcript, turns: 3 });
  });

  it('commits an exact cursor after every chunk, and a later run resumes from it', () => {
    // 25 turns, with a blank line and multibyte text between them: offsets are BYTES.
    let text = '';
    for (let i = 0; i < 25; i++) {
      text += `${i % 5 === 0 ? '\n' : ''}`;
      text += assistantLine(`a${i}`, `2026-08-20T10:00:${String(i).padStart(2, '0')}.000Z`, {
        ...USAGE,
        output_tokens: 100 + i,
      }).replace('working on it', `trabajando — 日本語 ${i}`);
    }
    writeFileSync(transcript, text);

    const firstRun = runTail({ chunkSize: 10, stopAfterChunks: 1 });
    expect(firstRun.events.map((e) => e.turn_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const lines = text.split('\n');
    const nonBlank = lines.filter((l) => l.length > 0);
    const through10 = Buffer.byteLength(
      `${lines.slice(0, lines.indexOf(nonBlank[9] as string) + 1).join('\n')}\n`,
    );
    expect(cursor()).toEqual({ offset: through10, path: transcript, turns: 10 });

    const rest = runTail({ chunkSize: 10 });
    expect(rest.events.map((e) => e.turn_number)).toEqual(
      Array.from({ length: 15 }, (_, i) => 11 + i),
    );
    const all = [...firstRun.events, ...rest.events];
    expect(new Set(all.map((e) => e.event_id)).size).toBe(25);
    expect(all.reduce((n, e) => n + (e.llm?.output_tokens ?? 0), 0)).toBe(
      Array.from({ length: 25 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0),
    );
    expect(cursor().offset).toBe(statSync(transcript).size);
  });

  it('a kill between a chunk’s enqueue and its commit re-reads that chunk with the same ids', () => {
    let text = '';
    for (let i = 0; i < 12; i++) {
      text += assistantLine(`a${i}`, `2026-08-20T10:00:${String(i).padStart(2, '0')}.000Z`, USAGE);
    }
    writeFileSync(transcript, text);
    const queued = new Set<string>();
    // chunk 1 queued and committed; chunk 2 queued but "killed" before its commit
    const killed = runTail({ chunkSize: 5, commit: false, stopAfterChunks: 2 });
    killed.chunks[0]?.commit();
    for (const e of killed.events) {
      queued.add(e.event_id);
    }
    expect(cursor().turns).toBe(5);

    const rerun = runTail({ chunkSize: 5 });
    const overlap = rerun.events.filter((e) => queued.has(e.event_id));
    expect(overlap.map((e) => e.turn_number)).toEqual([6, 7, 8, 9, 10]); // deduped by the queue
    for (const e of rerun.events) {
      queued.add(e.event_id);
    }
    expect(queued.size).toBe(12);
    expect(cursor().turns).toBe(12);
  });

  it('yields nothing without a transcript, a readable file or a usable session id', () => {
    expect(runTail({}, sessionEndPayload('/nonexistent.jsonl')).chunks).toHaveLength(0);
    const { transcript_path: _t, ...noPath } = sessionEndPayload();
    expect(runTail({}, noPath).chunks).toHaveLength(0);
    writeFileSync(transcript, assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE));
    const { session_id: _s, ...noSession } = sessionEndPayload();
    expect(runTail({}, noSession).chunks).toHaveLength(0); // nil session: no shared cursor
  });
});

// What a turn minted at SessionEnd shares with the same turn minted at Stop, and what it
// cannot. Claude Code (2.1.287) builds a SessionEnd payload as the base keys plus
// `reason`, with no permission mode or effort; a Stop adds permission_mode, effort,
// stop_hook_active, last_assistant_message, background_tasks and session_crons. Ingest keeps
// the first row that arrives for an (event_id, ts), so these differences are real but small.
describe('claudeCodeAdapter turns minted at SessionEnd versus at Stop', () => {
  const BASE = {
    agent_type: 'main',
    cwd: '/home/dev/proj',
    prompt_id: '0f1e2d3c-4b5a-4968-8776-655443322110',
    scratchpad_dir: '/tmp/claude-1000/scratch/3f8c2a1e',
    session_id: SESSION_ID,
  };

  function mint(kind: 'stop' | 'session-end') {
    // a fresh cursor each time
    rmSync(join(agentStateDir('claude-code')), { force: true, recursive: true });
    const out: ConformantEvent[] = [];
    if (kind === 'stop') {
      out.push(
        ...(claudeCodeAdapter.mapBatch?.('stop', {
          ...BASE,
          background_tasks: [],
          effort: 'high',
          hook_event_name: 'Stop',
          last_assistant_message: 'Done — I updated the file and ran the tests.',
          permission_mode: 'acceptEdits',
          session_crons: [],
          stop_hook_active: true,
          transcript_path: transcript,
        }) ?? []),
      );
      discardDeferred('test');
    } else {
      const gen = claudeCodeAdapter.tail?.(
        'session-end',
        { ...BASE, hook_event_name: 'SessionEnd', reason: 'clear', transcript_path: transcript },
        { chunkSize: 500, shouldStop: () => false },
      );
      for (const chunk of gen ?? []) {
        out.push(...chunk.events);
      }
    }
    return out;
  }

  it('are the same events except mode, effort and the Stop-only flag; never content', () => {
    writeFileSync(
      transcript,
      userLine('u1', '2026-08-20T10:00:00.000Z') +
        assistantLine('a1', '2026-08-20T10:00:05.000Z', USAGE, {
          id: 'toolu_01A09q90qw90lq917835lq9',
          name: 'Bash',
        }) +
        assistantLine('a2', '2026-08-20T10:00:09.000Z', USAGE),
    );
    const atStop = mint('stop');
    const atEnd = mint('session-end');
    expect(atEnd).toHaveLength(2);
    expect(atStop).toHaveLength(2);

    const norm = (e: ConformantEvent) => {
      const {
        client: _c,
        metadata,
        session_context,
        ...rest
      } = e as unknown as Record<string, unknown> & {
        metadata: Record<string, unknown>;
        session_context: Record<string, unknown>;
      };
      const { stop_hook_active: _s, effort: _e, ...meta } = metadata;
      const { mode: _m, ...ctx } = session_context;
      return { ...rest, metadata: meta, session_context: ctx };
    };
    expect(atEnd.map(norm)).toEqual(atStop.map(norm));

    // The differences, stated exactly: SessionEnd carries no permission mode (so the mode is
    // the default, not Stop's accept_edits) and no effort.
    expect(atStop[0]?.session_context.mode).toBe('accept_edits');
    expect(atEnd[0]?.session_context.mode).not.toBe('accept_edits');
    expect(atStop[0]?.metadata.effort).toBe('high');
    expect(atEnd[0]?.metadata.effort).toBeUndefined();

    // Provenance, never content: neither the message nor SessionEnd's own `reason`.
    const text = JSON.stringify(atEnd.map((e) => e.metadata));
    for (const leaked of ['Done', 'reason', 'background_tasks']) {
      expect(text).not.toContain(leaked);
    }
    expect(atEnd[0]?.metadata).toMatchObject({
      agent_type: 'main',
      prompt_id: BASE.prompt_id,
      scratchpad_dir: BASE.scratchpad_dir,
      source: 'claude-jsonl',
    });
  });
});
