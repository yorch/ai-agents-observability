import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event } from '@ai-agents-observability/schemas';

import { claudeCodeAdapter } from '../adapters/claude-code';
import { createSynthCtx, entryToEvents, noteSkippedEntry } from './import-synth';
import type { ClaudeEntry } from './transcript-parser';

// The P14-003 turn-linkage contract, and the cross-path agreement it rests on.
//
//   turn_number      1-based, monotonically increasing within a session_id, one
//                    increment per assistant turn. Carried by the turn's Stop and
//                    by the PreToolUse/PostToolUse events for the tools it issued.
//   parent_event_id  on a tool event, the event_id of its turn's Stop. NULL on
//                    the Stop itself and on non-tool events.
//
// SCOPE, stated once so a reader is not left guessing: the tool half of this
// contract is honoured on the IMPORT path only. A live PreToolUse/PostToolUse
// hook fires in its own process BEFORE the turn's Stop exists and has no way to
// name the assistant entry that issued it, so live tool events carry NULL
// linkage. See tasks/P14-003-claude-code-usage-capture.md.

const SESSION_ID = '3f8c2a1e-9d47-4b6a-8c25-1e7f0a9b4d63';
const MODEL = 'claude-opus-4-5-20251101';
const CWD = '/home/dev/proj';

const USAGE = {
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 12_000,
  input_tokens: 1500,
  output_tokens: 420,
};

function assistantEntry(
  uuid: string,
  ts: string,
  toolUses: { id: string; name: string }[] = [],
  usage: Record<string, number> | null = USAGE,
): ClaudeEntry {
  return {
    cwd: CWD,
    message: {
      content: [
        { text: 'on it', type: 'text' },
        ...toolUses.map((t) => ({
          id: t.id,
          input: { command: 'ls' },
          name: t.name,
          type: 'tool_use',
        })),
      ],
      model: MODEL,
      role: 'assistant',
      ...(usage ? { usage } : {}),
    },
    sessionId: SESSION_ID,
    timestamp: ts,
    type: 'assistant',
    uuid,
  };
}

function toolResultEntry(uuid: string, ts: string, toolUseId: string): ClaudeEntry {
  return {
    cwd: CWD,
    message: {
      content: [{ content: 'file-a\nfile-b', tool_use_id: toolUseId, type: 'tool_result' }],
      role: 'user',
    },
    sessionId: SESSION_ID,
    timestamp: ts,
    type: 'user',
    uuid,
  };
}

function userPromptEntry(uuid: string, ts: string): ClaudeEntry {
  return {
    cwd: CWD,
    message: { content: 'do the thing', role: 'user' },
    sessionId: SESSION_ID,
    timestamp: ts,
    type: 'user',
    uuid,
  };
}

/** A two-turn conversation: prompt → turn 1 (two tools) → results → turn 2 (one tool) → result. */
const CONVERSATION: ClaudeEntry[] = [
  userPromptEntry('u1', '2026-08-20T10:00:00.000Z'),
  assistantEntry('a1', '2026-08-20T10:00:05.000Z', [
    { id: 'toolu_1', name: 'Read' },
    { id: 'toolu_2', name: 'Bash' },
  ]),
  toolResultEntry('r1', '2026-08-20T10:00:06.000Z', 'toolu_1'),
  toolResultEntry('r2', '2026-08-20T10:00:07.000Z', 'toolu_2'),
  assistantEntry('a2', '2026-08-20T10:00:12.000Z', [{ id: 'toolu_3', name: 'Edit' }]),
  toolResultEntry('r3', '2026-08-20T10:00:13.000Z', 'toolu_3'),
];

function importAll(entries: ClaudeEntry[] = CONVERSATION): Event[] {
  const ctx = createSynthCtx(SESSION_ID, CWD, '1.2.3');
  return entries.flatMap((e) => entryToEvents(e, ctx));
}

const byTool = (events: Event[], name: string, type: Event['event_type']): Event | undefined =>
  events.find((e) => e.event_type === type && e.tool?.name === name);

describe('turn linkage — import path', () => {
  const events = importAll();
  const stops = events.filter((e) => e.event_type === 'Stop');

  it('numbers turns 1-based, one increment per assistant turn', () => {
    expect(stops.map((s) => s.turn_number)).toEqual([1, 2]);
  });

  it('leaves parent_event_id null on the Stop itself', () => {
    for (const stop of stops) {
      expect(stop.parent_event_id ?? null).toBeNull();
    }
  });

  it('points every tool event at its issuing turn’s Stop', () => {
    const turn1 = stops[0];
    const turn2 = stops[1];
    for (const name of ['Read', 'Bash']) {
      for (const type of ['PreToolUse', 'PostToolUse'] as const) {
        const ev = byTool(events, name, type);
        expect(ev?.turn_number).toBe(1);
        expect(ev?.parent_event_id).toBe(turn1?.event_id);
      }
    }
    for (const type of ['PreToolUse', 'PostToolUse'] as const) {
      const ev = byTool(events, 'Edit', type);
      expect(ev?.turn_number).toBe(2);
      expect(ev?.parent_event_id).toBe(turn2?.event_id);
    }
  });

  it('carries the turn’s usage on its Stop', () => {
    expect(stops[0]?.llm?.input_tokens).toBe(1500);
    expect(stops[0]?.llm?.model).toBe(MODEL);
    expect(stops[0]?.llm?.cost_usd).toBe(0);
  });

  it('leaves a non-tool event unlinked', () => {
    const prompt = events.find((e) => e.event_type === 'UserPromptSubmit');
    expect(prompt?.parent_event_id ?? null).toBeNull();
    expect(prompt?.turn_number).toBeUndefined();
  });

  it('leaves linkage null for a tool_result whose tool_use was never seen', () => {
    const orphan = importAll([toolResultEntry('r9', '2026-08-20T10:00:06.000Z', 'toolu_unseen')]);
    expect(orphan[0]?.parent_event_id ?? null).toBeNull();
    expect(orphan[0]?.turn_number).toBeUndefined();
  });

  it('numbers --since imports exactly as a full import would', () => {
    // The skip path must still count the turns it walks past, or a windowed
    // import disagrees with a full one about which Stop a tool belongs to.
    const ctx = createSynthCtx(SESSION_ID, CWD, '1.2.3');
    const cutoff = new Date('2026-08-20T10:00:10.000Z');
    const emitted: Event[] = [];
    for (const entry of CONVERSATION) {
      if (new Date(entry.timestamp as string) < cutoff) {
        noteSkippedEntry(entry, ctx);
        continue;
      }
      emitted.push(...entryToEvents(entry, ctx));
    }
    const stop = emitted.find((e) => e.event_type === 'Stop');
    expect(stop?.turn_number).toBe(2);
    expect(byTool(emitted, 'Edit', 'PreToolUse')?.parent_event_id).toBe(stop?.event_id);
    // …and the tool_result for a call issued before the cutoff still resolves.
    expect(byTool(emitted, 'Edit', 'PostToolUse')?.turn_number).toBe(2);
  });
});

describe('turn linkage — live and import paths agree', () => {
  let home: string;
  let transcript: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'claude-linkage-test-'));
    process.env.CLAUDE_TELEMETRY_HOME = home;
    transcript = join(home, 'session.jsonl');
    writeFileSync(transcript, CONVERSATION.map((e) => `${JSON.stringify(e)}\n`).join(''));
  });

  afterEach(() => {
    rmSync(home, { force: true, recursive: true });
    process.env.CLAUDE_TELEMETRY_HOME = undefined;
  });

  // THE guarantee that makes live capture and a later `claude-telemetry import`
  // of the same session safe. Ingest dedupes on
  // `ON CONFLICT (event_id, ts) DO NOTHING`, so identical (event_id, ts) means
  // the second path is a no-op — and `sessions.total_cost_usd` accumulates
  // (`= sessions.x + EXCLUDED.x`) and is never recomputed, so anything less than
  // an exact match would double-bill the session permanently.
  it('produce identical (event_id, ts, turn_number, usage) for the same turns', () => {
    const live = claudeCodeAdapter.mapBatch?.('stop', {
      cwd: CWD,
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
      transcript_path: transcript,
    });
    const imported = importAll().filter((e) => e.event_type === 'Stop');

    expect(live).toHaveLength(imported.length);
    expect(live?.map((e) => [e.event_id, e.ts, e.turn_number])).toEqual(
      imported.map((e) => [e.event_id, e.ts, e.turn_number]),
    );
    expect(live?.map((e) => e.llm)).toEqual(imported.map((e) => e.llm));
  });
});
