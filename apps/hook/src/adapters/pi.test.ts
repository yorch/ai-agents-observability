import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectAdapter } from '.';
import { conformanceErrors } from './conformance';
import { piAdapter } from './pi';

// Pi session ids are UUIDs natively — the one adapter where deriving a new id
// would be WRONG (users would stop being able to match ours to Pi's own).
const SESSION_ID = 'b41e7d92-8c3a-4f16-9a07-2d5e8c1b3f40';

describe('pi adapter', () => {
  let piHome: string;

  function writeSession(lines: object[]): string {
    const dir = join(piHome, 'agent', 'sessions', '--home-dev-proj--');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-08-13T10-00-00_${SESSION_ID}.jsonl`);
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
    return path;
  }

  beforeEach(() => {
    piHome = mkdtempSync(join(tmpdir(), 'pi-home-'));
    process.env.PI_HOME = piHome;
  });

  afterEach(() => {
    rmSync(piHome, { force: true, recursive: true });
    delete process.env.PI_HOME;
  });

  it('is selectable by --agent pi', () => {
    expect(selectAdapter('pi')).toBe(piAdapter);
    expect(selectAdapter('PI')).toBe(piAdapter);
  });

  it('maps the Pi event vocabulary onto canonical types', () => {
    const cases: [string, string][] = [
      ['session-start', 'SessionStart'],
      ['user-prompt-submit', 'UserPromptSubmit'],
      ['pre-tool-use', 'PreToolUse'],
      ['post-tool-use', 'PostToolUse'],
      ['stop', 'Stop'],
      ['pre-compact', 'PreCompact'],
      ['session-end', 'SessionEnd'],
    ];
    for (const [kind, expected] of cases) {
      const ev = piAdapter.mapPayload(kind, { sessionId: SESSION_ID, toolName: 'bash' });
      expect(ev.event_type).toBe(expected as never);
      expect(ev.agent_type).toBe('PI');
      expect(conformanceErrors(ev)).toEqual([]);
    }
  });

  it("passes Pi's native UUID session id through untouched", () => {
    const ev = piAdapter.mapPayload('session-start', { sessionId: SESSION_ID });
    expect(ev.session_id).toBe(SESSION_ID);
  });

  it('builds a tool block from tool_call / tool_result payloads', () => {
    const pre = piAdapter.mapPayload('pre-tool-use', {
      args: { command: 'ls -la' },
      cwd: '/home/dev/proj',
      sessionId: SESSION_ID,
      toolName: 'bash',
    });
    expect(pre.tool?.name).toBe('bash');
    expect(pre.tool?.input_bytes).toBeGreaterThan(0);
    expect(pre.session_context.cwd).toBe('/home/dev/proj');

    const post = piAdapter.mapPayload('post-tool-use', {
      denied: true,
      result: 'a\nb\n',
      sessionId: SESSION_ID,
      toolName: 'bash',
    });
    expect(post.tool?.output_bytes).toBeGreaterThan(0);
    expect(post.tool?.was_denied).toBe(true);
  });

  it('attaches usage forwarded on turn_end', () => {
    const ev = piAdapter.mapPayload('stop', {
      model: 'claude-sonnet-4-5-20250929',
      sessionId: SESSION_ID,
      usage: { cache: { read: 900, write: 100 }, input: 2400, output: 310 },
    });
    expect(ev.llm?.input_tokens).toBe(2400);
    expect(ev.llm?.output_tokens).toBe(310);
    expect(ev.llm?.cache_read_tokens).toBe(900);
    expect(ev.llm?.cache_creation_tokens).toBe(100);
    expect(ev.llm?.model).toBe('claude-sonnet-4-5-20250929');
    // Cost is recomputed ingest-side from the pi price table, never trusted here.
    expect(ev.llm?.cost_usd).toBe(0);
  });

  it('recovers usage from the session file when the extension forwarded none', () => {
    writeSession([
      { cwd: '/home/dev/proj', id: 'aaaa1111', type: 'session', version: 1 },
      {
        id: 'bbbb2222',
        message: {
          model: 'gpt-5.2',
          role: 'assistant',
          usage: { input: 1200, output: 90 },
        },
        parentId: 'aaaa1111',
        type: 'message',
      },
    ]);
    const ev = piAdapter.mapPayload('stop', { sessionId: SESSION_ID });
    expect(ev.llm?.input_tokens).toBe(1200);
    expect(ev.llm?.output_tokens).toBe(90);
    expect(ev.llm?.model).toBe('gpt-5.2');
  });

  it('emits a usage-less Stop rather than a wrong one when nothing is recoverable', () => {
    const ev = piAdapter.mapPayload('stop', { sessionId: SESSION_ID });
    expect(ev.llm).toBeUndefined();
    expect(conformanceErrors(ev)).toEqual([]);
  });

  it('ships the single-file JSONL transcript (the gap opencode still has)', () => {
    const path = writeSession([{ id: 'aaaa1111', type: 'session' }]);
    const target = piAdapter.transcriptTarget('stop', { sessionId: SESSION_ID });
    expect(target).toEqual({ sessionId: SESSION_ID, transcriptPath: path });
    // Non-terminal events ship nothing.
    expect(piAdapter.transcriptTarget('pre-tool-use', { sessionId: SESSION_ID })).toBeNull();
  });

  it('matches the session file exactly, not by substring', () => {
    // A `…_<id>-branch2.jsonl` sibling with a NEWER mtime must not win: taking it
    // would attach another session's usage and upload its transcript under this
    // session's id.
    const dir = join(piHome, 'agent', 'sessions', '--home-dev-proj--');
    mkdirSync(dir, { recursive: true });
    const real = join(dir, `2026-08-13T10-00-00_${SESSION_ID}.jsonl`);
    writeFileSync(
      real,
      `${JSON.stringify({ message: { role: 'assistant', usage: { input: 11, output: 1 } }, type: 'message' })}\n`,
      'utf8',
    );
    const decoy = join(dir, `2026-08-14T10-00-00_${SESSION_ID}-branch2.jsonl`);
    writeFileSync(
      decoy,
      `${JSON.stringify({ message: { role: 'assistant', usage: { input: 999, output: 99 } }, type: 'message' })}\n`,
      'utf8',
    );

    expect(piAdapter.transcriptTarget('stop', { sessionId: SESSION_ID })?.transcriptPath).toBe(
      real,
    );
    expect(piAdapter.mapPayload('stop', { sessionId: SESSION_ID }).llm?.input_tokens).toBe(11);
  });

  it('does not mistake a per-entry `id` for the session id', () => {
    // Pi puts a per-message id on its event payloads. Accepting it as a session
    // id would give every event of one session a different session_id.
    const a = piAdapter.mapPayload('pre-tool-use', { id: 'msg_0001', toolName: 'bash' });
    const b = piAdapter.mapPayload('pre-tool-use', { id: 'msg_0002', toolName: 'bash' });
    expect(a.session_id).toBe(b.session_id);
  });

  it('keeps unmodelled fields in metadata on non-tool events', () => {
    const ev = piAdapter.mapPayload('session-start', { name: 'my session', sessionId: SESSION_ID });
    expect(ev.metadata.name).toBe('my session');
  });

  it('ships nothing when the payload carries no session id', () => {
    expect(piAdapter.transcriptTarget('stop', { sessionFile: '/tmp/x.jsonl' })).toBeNull();
  });

  it('prefers an explicit session file path from the extension over scanning', () => {
    const target = piAdapter.transcriptTarget('session-end', {
      sessionFile: '/custom/path/session.jsonl',
      sessionId: SESSION_ID,
    });
    expect(target?.transcriptPath).toBe('/custom/path/session.jsonl');
  });

  it('renders an extension that observes without blocking', () => {
    const snippet = piAdapter.installConfig().renderSnippet('/usr/local/bin/claude-telemetry');
    expect(snippet).toContain('pi.on(native');
    expect(snippet).toContain('tool_call');
    expect(snippet).toContain("'hook', kind, '--agent', 'pi'");
    // The handler must not return a blocking verdict — pi.on('tool_call') can deny.
    expect(snippet).toContain('never blocks a tool');
  });
});
