import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collateDirectory } from '../lib/transcript-collate';
import { selectAdapter } from '.';
import { conformanceErrors } from './conformance';
import { opencodeAdapter } from './opencode';

// Realistic opencode session id: `ses_`-prefixed, NOT a UUID (see P12-002).
const SESSION_ID = 'ses_7bQx19aMfTk3';

describe('opencode adapter', () => {
  it('is selectable by --agent opencode and falls back to claude-code otherwise', () => {
    expect(selectAdapter('opencode')).toBe(opencodeAdapter);
    expect(selectAdapter('claude-code').agentType).toBe('CLAUDE_CODE');
    expect(selectAdapter(undefined).agentType).toBe('CLAUDE_CODE');
    expect(selectAdapter('nonsense').agentType).toBe('CLAUDE_CODE');
  });

  it('recognizes opencode hook kinds', () => {
    expect(opencodeAdapter.isHookKind('pre-tool-use')).toBe(true);
    expect(opencodeAdapter.isHookKind('session-idle')).toBe(true);
    expect(opencodeAdapter.isHookKind('not-a-kind')).toBe(false);
  });

  it('maps a tool event to a PostToolUse with agent_type=opencode and a tool block', () => {
    const ev = opencodeAdapter.mapPayload('post-tool-use', {
      args: { command: 'ls' },
      directory: '/home/dev/proj',
      result: 'a\nb\n',
      sessionID: SESSION_ID,
      tool: 'bash',
    });
    expect(ev.agent_type).toBe('OPENCODE');
    expect(ev.event_type).toBe('PostToolUse');
    expect(ev.tool?.name).toBe('bash');
    expect(ev.tool?.input_bytes).toBeGreaterThan(0);
    expect(ev.session_context.cwd).toBe('/home/dev/proj');
  });

  // P14-010: no documented duration field on tool.execute.after, so this is a
  // defensive read; absence must stay null, never fall back to 0.
  it('reads duration_ms when present and stays null when absent or malformed', () => {
    const withDuration = opencodeAdapter.mapPayload('post-tool-use', {
      duration_ms: 120,
      sessionID: SESSION_ID,
      tool: 'bash',
    });
    expect(withDuration.tool?.duration_ms).toBe(120);

    const absent = opencodeAdapter.mapPayload('post-tool-use', {
      sessionID: SESSION_ID,
      tool: 'bash',
    });
    expect(absent.tool?.duration_ms).toBe(null);

    const malformed = opencodeAdapter.mapPayload('post-tool-use', {
      duration_ms: -5,
      sessionID: SESSION_ID,
      tool: 'bash',
    });
    expect(malformed.tool?.duration_ms).toBe(null);
    expect(conformanceErrors(malformed)).toEqual([]);
  });

  it('attaches an llm block (with model) so ingest can price via the opencode table', () => {
    const ev = opencodeAdapter.mapPayload('session-idle', {
      model: 'claude-sonnet-4-5-20250929',
      sessionID: SESSION_ID,
      tokens: { input: 1000, output: 200, reasoning: 25 },
    });
    expect(ev.event_type).toBe('Stop');
    expect(ev.llm?.model).toBe('claude-sonnet-4-5-20250929');
    expect(ev.llm?.input_tokens).toBe(1000);
    expect(ev.llm?.output_tokens).toBe(225);
  });

  // The regression test for P12-002: before normalization, a real `ses_` id failed
  // EventSchema and ingest discarded the event.
  it('emits an EventSchema-conformant event from a real ses_-prefixed session id', () => {
    const ev = opencodeAdapter.mapPayload('post-tool-use', {
      args: { filePath: '/tmp/x' },
      directory: '/home/dev/proj',
      sessionID: SESSION_ID,
      tool: 'read',
    });
    expect(conformanceErrors(ev)).toEqual([]);
    expect(ev.session_id).not.toBe(SESSION_ID);
  });

  it('keeps every event of one session under the same session_id', () => {
    const start = opencodeAdapter.mapPayload('session-start', { sessionID: SESSION_ID });
    const stop = opencodeAdapter.mapPayload('session-idle', { sessionID: SESSION_ID });
    expect(start.session_id).toBe(stop.session_id);
  });

  it('returns null transcriptTarget when the session cannot be located', () => {
    expect(opencodeAdapter.transcriptTarget('session-idle', {})).toBeNull();
  });
});

// P12-009: opencode's directory-shaped history no longer blocks transcript
// upload. The adapter points at the storage DIRECTORY and the shipper collates it.
describe('opencode transcript export', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'opencode-data-'));
    process.env.OPENCODE_DATA = dataDir;
  });

  afterEach(() => {
    rmSync(dataDir, { force: true, recursive: true });
    delete process.env.OPENCODE_DATA;
  });

  it('locates the session storage directory by name at bounded depth', () => {
    const sessionDir = join(dataDir, 'message', SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'msg_1.json'), '{"id":"msg_1"}', 'utf8');

    const target = opencodeAdapter.transcriptTarget('session-idle', { sessionID: SESSION_ID });
    expect(target?.transcriptPath).toBe(sessionDir);
    // Keyed to the same normalized session id the events carry.
    expect(target?.sessionId).toBe(
      opencodeAdapter.mapPayload('session-idle', { sessionID: SESSION_ID }).session_id,
    );
  });

  it('ships nothing for non-terminal events', () => {
    mkdirSync(join(dataDir, 'message', SESSION_ID), { recursive: true });
    expect(opencodeAdapter.transcriptTarget('pre-tool-use', { sessionID: SESSION_ID })).toBeNull();
  });

  it('collates that directory into an ordered JSONL the shipper can read', () => {
    const sessionDir = join(dataDir, 'message', SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'msg_b.json'),
      JSON.stringify({ id: 'msg_b', role: 'assistant', time: { created: 2 } }),
      'utf8',
    );
    writeFileSync(
      join(sessionDir, 'msg_a.json'),
      JSON.stringify({ id: 'msg_a', role: 'user', time: { created: 1 } }),
      'utf8',
    );

    const dest = join(dataDir, 'out.jsonl');
    expect(collateDirectory(sessionDir, dest)).toBe(2);
    const roles = readFileSync(dest, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).role);
    expect(roles).toEqual(['user', 'assistant']);
  });
});
