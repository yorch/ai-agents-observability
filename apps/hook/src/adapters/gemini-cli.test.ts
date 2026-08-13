import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectAdapter } from '.';
import { conformanceErrors } from './conformance';
import { geminiCliAdapter } from './gemini-cli';

const SESSION_ID = '7c1d9f30-4a2b-4e88-9d51-6b0e3a7c2f14';

describe('gemini-cli adapter', () => {
  let telHome: string;

  beforeEach(() => {
    telHome = mkdtempSync(join(tmpdir(), 'gemini-tel-'));
    process.env.CLAUDE_TELEMETRY_HOME = telHome;
  });

  afterEach(() => {
    rmSync(telHome, { force: true, recursive: true });
    delete process.env.CLAUDE_TELEMETRY_HOME;
  });

  it('is selectable by --agent gemini-cli', () => {
    expect(selectAdapter('gemini-cli')).toBe(geminiCliAdapter);
    expect(selectAdapter('GEMINI_CLI')).toBe(geminiCliAdapter);
    expect(selectAdapter('nonsense').agentType).toBe('CLAUDE_CODE');
  });

  it("maps Gemini's own event names onto canonical types", () => {
    const cases: [string, string][] = [
      ['session-start', 'SessionStart'],
      ['before-agent', 'UserPromptSubmit'],
      ['before-tool', 'PreToolUse'],
      ['after-tool', 'PostToolUse'],
      ['after-agent', 'Stop'],
      ['pre-compress', 'PreCompact'],
      ['session-end', 'SessionEnd'],
    ];
    for (const [kind, expected] of cases) {
      const ev = geminiCliAdapter.mapPayload(kind, { session_id: SESSION_ID });
      expect(ev.event_type).toBe(expected as never);
      expect(ev.agent_type).toBe('GEMINI_CLI');
      expect(conformanceErrors(ev)).toEqual([]);
    }
  });

  it('does not register events with no canonical equivalent', () => {
    expect(geminiCliAdapter.isHookKind('before-model')).toBe(false);
    expect(geminiCliAdapter.isHookKind('before-tool-selection')).toBe(false);
    // after-model IS registered — it is harvested for usage, not emitted.
    expect(geminiCliAdapter.isHookKind('after-model')).toBe(true);
  });

  it('sizes AfterTool output from llmContent and flags errors via exit_status', () => {
    const ok = geminiCliAdapter.mapPayload('after-tool', {
      session_id: SESSION_ID,
      tool_input: { file_path: '/tmp/x' },
      tool_name: 'read_file',
      tool_response: { llmContent: 'file contents here', returnDisplay: 'read /tmp/x' },
    });
    expect(ok.tool?.name).toBe('read_file');
    expect(ok.tool?.output_bytes).toBe('file contents here'.length);
    expect(ok.tool?.exit_status).toBeNull();

    const failed = geminiCliAdapter.mapPayload('after-tool', {
      session_id: SESSION_ID,
      tool_name: 'read_file',
      tool_response: { error: 'ENOENT', llmContent: '' },
    });
    expect(failed.tool?.exit_status).toBe(1);
  });

  it('fills mcp_server / mcp_tool from mcp_context', () => {
    const ev = geminiCliAdapter.mapPayload('before-tool', {
      mcp_context: { server_name: 'github' },
      original_request_name: 'list_issues',
      session_id: SESSION_ID,
      tool_name: 'github__list_issues',
    });
    expect(ev.tool?.category).toBe('mcp');
    expect(ev.tool?.mcp_server).toBe('github');
    expect(ev.tool?.mcp_tool).toBe('list_issues');
  });

  it('accumulates AfterModel usage and drains it onto the turn Stop', () => {
    const harvested = geminiCliAdapter.mapBatch?.('after-model', {
      llm_request: { model: 'gemini-3-pro' },
      llm_response: {
        usageMetadata: {
          cachedContentTokenCount: 400,
          candidatesTokenCount: 220,
          promptTokenCount: 1500,
        },
      },
      session_id: SESSION_ID,
    });
    // AfterModel has no canonical event type — harvested, never emitted.
    expect(harvested).toEqual([]);

    // A second model call in the same turn adds to the first.
    geminiCliAdapter.mapBatch?.('after-model', {
      llm_request: { model: 'gemini-3-pro' },
      llm_response: { usageMetadata: { candidatesTokenCount: 80, promptTokenCount: 500 } },
      session_id: SESSION_ID,
    });

    const stop = geminiCliAdapter.mapBatch?.('after-agent', { session_id: SESSION_ID })?.[0];
    expect(stop?.event_type).toBe('Stop');
    expect(stop?.llm?.input_tokens).toBe(2000);
    expect(stop?.llm?.output_tokens).toBe(300);
    expect(stop?.llm?.cache_read_tokens).toBe(400);
    expect(stop?.llm?.model).toBe('gemini-3-pro');
    expect(conformanceErrors(stop)).toEqual([]);
  });

  it('resets the accumulator per turn so the next Stop is not double-counted', () => {
    geminiCliAdapter.mapBatch?.('after-model', {
      llm_request: { model: 'gemini-3-pro' },
      llm_response: { usageMetadata: { candidatesTokenCount: 10, promptTokenCount: 100 } },
      session_id: SESSION_ID,
    });
    geminiCliAdapter.mapBatch?.('after-agent', { session_id: SESSION_ID });

    const second = geminiCliAdapter.mapBatch?.('after-agent', { session_id: SESSION_ID })?.[0];
    expect(second?.llm).toBeUndefined();
  });

  it('emits a usage-less Stop rather than a wrong one when the shape is unrecognized', () => {
    geminiCliAdapter.mapBatch?.('after-model', {
      llm_response: { something: 'unexpected' },
      session_id: SESSION_ID,
    });
    const stop = geminiCliAdapter.mapBatch?.('after-agent', { session_id: SESSION_ID })?.[0];
    expect(stop?.llm).toBeUndefined();
    expect(conformanceErrors(stop)).toEqual([]);
  });

  it('ships the transcript Gemini names in the payload', () => {
    const raw = { session_id: SESSION_ID, transcript_path: '/home/d/.gemini/tmp/session.json' };
    expect(geminiCliAdapter.transcriptTarget('after-agent', raw)).toEqual({
      sessionId: SESSION_ID,
      transcriptPath: '/home/d/.gemini/tmp/session.json',
    });
    expect(geminiCliAdapter.transcriptTarget('before-tool', raw)).toBeNull();
  });

  it('renders a settings.json hooks block keyed by Gemini event names', () => {
    const snippet = geminiCliAdapter
      .installConfig()
      .renderSnippet('/usr/local/bin/claude-telemetry');
    const parsed = JSON.parse(snippet) as {
      hooks: Record<string, { hooks: { command: string; type: string }[] }[]>;
    };
    expect(Object.keys(parsed.hooks)).toContain('BeforeTool');
    expect(Object.keys(parsed.hooks)).toContain('AfterModel');
    const entry = parsed.hooks.BeforeTool?.[0]?.hooks[0];
    expect(entry?.type).toBe('command');
    expect(entry?.command).toContain('hook before-tool --agent gemini-cli');
  });

  it('quotes a binary path containing spaces in the rendered command', () => {
    const snippet = geminiCliAdapter
      .installConfig()
      .renderSnippet('/home/jorge barnaby/.local/bin/claude-telemetry');
    const parsed = JSON.parse(snippet) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(parsed.hooks.AfterTool?.[0]?.hooks[0]?.command).toContain(
      '"/home/jorge barnaby/.local/bin/claude-telemetry"',
    );
  });
});
