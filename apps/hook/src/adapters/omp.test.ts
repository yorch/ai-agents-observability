import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectAdapter } from '.';
import { conformanceErrors } from './conformance';
import { ompAdapter } from './omp';
import { safeJsonObject } from './pi-family';

// OMP session ids are 16-char hex, not UUIDs.
const SESSION_ID = '1f9d2a6b9c0d1234';

// OMP session files open with a fixed-width title slot before the header line.
const TITLE_SLOT = `${'my session title'.padEnd(255, ' ')}\n`;

describe('omp adapter', () => {
  let ompHome: string;

  function writeSession(lines: object[], preamble = ''): string {
    const dir = join(ompHome, 'agent', 'sessions', 'abs-proj-9f2b71');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-08-13T10-00-00_${SESSION_ID}.jsonl`);
    writeFileSync(path, `${preamble + lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
    return path;
  }

  beforeEach(() => {
    ompHome = mkdtempSync(join(tmpdir(), 'omp-home-'));
    process.env.OMP_HOME = ompHome;
  });

  afterEach(() => {
    rmSync(ompHome, { force: true, recursive: true });
    delete process.env.OMP_HOME;
  });

  it('is selectable by --agent omp', () => {
    expect(selectAdapter('omp')).toBe(ompAdapter);
    expect(selectAdapter('OMP')).toBe(ompAdapter);
  });

  it('derives a stable UUID from the 16-hex session id', () => {
    const start = ompAdapter.mapPayload('session-start', { sessionId: SESSION_ID });
    const stop = ompAdapter.mapPayload('stop', { sessionId: SESSION_ID });
    expect(conformanceErrors(start)).toEqual([]);
    expect(start.session_id).not.toBe(SESSION_ID);
    expect(start.session_id).toBe(stop.session_id);
  });

  it('does not collide with Pi on the same native session id', () => {
    const omp = ompAdapter.mapPayload('session-start', { sessionId: 'shared-id-abc' });
    const pi = selectAdapter('pi').mapPayload('session-start', { sessionId: 'shared-id-abc' });
    expect(omp.session_id).not.toBe(pi.session_id);
  });

  it('maps tool_call / tool_result and forwards subagent type', () => {
    const ev = ompAdapter.mapPayload('post-tool-use', {
      result: 'done',
      sessionId: SESSION_ID,
      subagentType: 'reviewer',
      toolName: 'edit',
    });
    expect(ev.event_type).toBe('PostToolUse');
    expect(ev.agent_type).toBe('OMP');
    expect(ev.tool?.name).toBe('edit');
    expect(ev.tool?.subagent_type).toBe('reviewer');
  });

  it('attaches usage on turn_end', () => {
    const ev = ompAdapter.mapPayload('stop', {
      model: 'gpt-5.3-codex',
      sessionId: SESSION_ID,
      usage: { cacheRead: 500, input: 3000, output: 400 },
    });
    expect(ev.llm?.input_tokens).toBe(3000);
    expect(ev.llm?.output_tokens).toBe(400);
    expect(ev.llm?.cache_read_tokens).toBe(500);
    expect(ev.llm?.model).toBe('gpt-5.3-codex');
  });

  it('reads usage past the 256-byte title slot at the head of the file', () => {
    writeSession(
      [
        { id: 'aaaa1111', type: 'session' },
        {
          id: 'bbbb2222',
          message: { model: 'gpt-5.2', role: 'assistant', usage: { input: 800, output: 60 } },
          type: 'message',
        },
      ],
      TITLE_SLOT,
    );
    const ev = ompAdapter.mapPayload('stop', { sessionId: SESSION_ID });
    expect(ev.llm?.input_tokens).toBe(800);
    expect(ev.llm?.output_tokens).toBe(60);
  });

  it('ships the single-file JSONL transcript', () => {
    const path = writeSession([{ id: 'aaaa1111', type: 'session' }], TITLE_SLOT);
    const target = ompAdapter.transcriptTarget('session-end', { sessionId: SESSION_ID });
    expect(target?.transcriptPath).toBe(path);
    expect(target?.sessionId).toBe(
      ompAdapter.mapPayload('stop', { sessionId: SESSION_ID }).session_id,
    );
  });

  it('names both documented config roots in the install snippet', () => {
    const snippet = ompAdapter.installConfig().renderSnippet('/usr/local/bin/aiot');
    expect(snippet).toContain('.omp/agent/hooks');
    expect(snippet).toContain('.oh-omp');
  });

  it('accepts an OMP_HOME that names the sessions directory itself', () => {
    // A natural misreading of the docs; resolving it to nothing would silently
    // cost the transcript.
    const path = writeSession([{ id: 'aaaa1111', type: 'session' }]);
    process.env.OMP_HOME = join(ompHome, 'agent', 'sessions');
    expect(ompAdapter.transcriptTarget('stop', { sessionId: SESSION_ID })?.transcriptPath).toBe(
      path,
    );
  });

  it('ships nothing when no session file can be found', () => {
    expect(ompAdapter.transcriptTarget('stop', { sessionId: 'ffffffffffffffff' })).toBeNull();
  });

  it('documents the omp-hooks alternative without depending on it', () => {
    const snippet = ompAdapter.installConfig().renderSnippet('/usr/local/bin/aiot');
    expect(snippet).toContain('omp-hooks');
    expect(snippet).toContain("'hook', kind, '--agent', 'omp'");
  });
});

describe('safeJsonObject', () => {
  it('parses a plain JSONL line', () => {
    expect(safeJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers a record hidden behind a fixed-width preamble', () => {
    expect(safeJsonObject(`${'title'.padEnd(60, ' ')}{"type":"session"}`)).toEqual({
      type: 'session',
    });
  });

  it('returns null for a line with no object at all', () => {
    expect(safeJsonObject('not json')).toBeNull();
    expect(safeJsonObject('[1,2,3]')).toBeNull();
  });
});
