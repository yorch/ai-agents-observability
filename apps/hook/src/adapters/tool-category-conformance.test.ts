import { describe, expect, it } from 'bun:test';

import { TOOL_CATEGORIES } from '@ai-agents-observability/schemas';

import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { conformanceErrors } from './conformance';
import { copilotAdapter } from './copilot';
import { geminiCliAdapter } from './gemini-cli';
import type { HookAdapter } from './index';
import { ompAdapter } from './omp';
import { opencodeAdapter } from './opencode';
import { piAdapter } from './pi';

// Conformance, in the spirit of conformance.ts (P14-002): that file asserts every
// adapter emits an EventSchema-conformant event; this asserts every adapter's
// PostToolUse `tool.category` stays inside the DESIGN_DOC §5.3 taxonomy — for a
// known tool name (exercising the per-agent map), an unrecognized one (exercising
// the 'other' fallback), and an MCP call (exercising each adapter's own MCP
// detection). A category outside TOOL_CATEGORIES would mean an adapter bypassed
// `toolCategory()` — e.g. still hardcoding 'builtin' — and this catches it at the
// real call path rather than only at the unit level.

const SESSION_ID = '9b1d3e5f-7a2c-4b6d-8e91-0f3a5c7d9b21';

type Case = { adapter: HookAdapter; kind: string; label: string; payload: Record<string, unknown> };

const CASES: Case[] = [
  {
    adapter: claudeCodeAdapter,
    kind: 'pre-tool-use',
    label: 'claude-code known tool',
    payload: { session_id: SESSION_ID, tool_input: { command: 'ls' }, tool_name: 'Bash' },
  },
  {
    adapter: claudeCodeAdapter,
    kind: 'pre-tool-use',
    label: 'claude-code unknown tool',
    payload: { session_id: SESSION_ID, tool_name: 'SomeFutureTool' },
  },
  {
    adapter: claudeCodeAdapter,
    kind: 'pre-tool-use',
    label: 'claude-code mcp (no tool segment)',
    payload: { session_id: SESSION_ID, tool_name: 'mcp__server' },
  },
  {
    adapter: codexAdapter,
    kind: 'pre-tool-use',
    label: 'codex known tool',
    payload: { session_id: SESSION_ID, tool_input: { command: 'ls' }, tool_name: 'shell' },
  },
  {
    adapter: codexAdapter,
    kind: 'pre-tool-use',
    label: 'codex unknown tool',
    payload: { session_id: SESSION_ID, tool_name: 'some_future_tool' },
  },
  {
    adapter: codexAdapter,
    kind: 'post-tool-use',
    label: 'codex mcp',
    payload: { session_id: SESSION_ID, tool_name: 'mcp__github__list_issues' },
  },
  {
    adapter: geminiCliAdapter,
    kind: 'before-tool',
    label: 'gemini-cli known tool',
    payload: {
      session_id: SESSION_ID,
      tool_input: { file_path: '/tmp/x' },
      tool_name: 'read_file',
    },
  },
  {
    adapter: geminiCliAdapter,
    kind: 'before-tool',
    label: 'gemini-cli unknown tool',
    payload: { session_id: SESSION_ID, tool_name: 'some_future_tool' },
  },
  {
    adapter: geminiCliAdapter,
    kind: 'before-tool',
    label: 'gemini-cli mcp (via mcp_context)',
    payload: {
      mcp_context: { server_name: 'github' },
      original_request_name: 'list_issues',
      session_id: SESSION_ID,
      tool_name: 'github__list_issues',
    },
  },
  {
    adapter: copilotAdapter,
    kind: 'pre-tool-use',
    label: 'copilot known tool',
    payload: { sessionId: SESSION_ID, toolName: 'bash' },
  },
  {
    adapter: copilotAdapter,
    kind: 'pre-tool-use',
    label: 'copilot unknown tool',
    payload: { sessionId: SESSION_ID, toolName: 'some_future_tool' },
  },
  {
    adapter: copilotAdapter,
    kind: 'pre-tool-use',
    label: 'copilot mcp',
    payload: { sessionId: SESSION_ID, toolName: 'mcp__github__list_issues' },
  },
  {
    adapter: opencodeAdapter,
    kind: 'pre-tool-use',
    label: 'opencode known tool',
    payload: { args: { command: 'ls' }, sessionID: 'ses_abc123', tool: 'bash' },
  },
  {
    adapter: opencodeAdapter,
    kind: 'pre-tool-use',
    label: 'opencode unknown tool',
    payload: { sessionID: 'ses_abc123', tool: 'some_future_tool' },
  },
  {
    adapter: piAdapter,
    kind: 'pre-tool-use',
    label: 'pi known tool',
    payload: { sessionId: SESSION_ID, toolName: 'bash' },
  },
  {
    adapter: piAdapter,
    kind: 'pre-tool-use',
    label: 'pi unknown tool',
    payload: { sessionId: SESSION_ID, toolName: 'some_future_tool' },
  },
  {
    adapter: piAdapter,
    kind: 'pre-tool-use',
    label: 'pi mcp',
    payload: { sessionId: SESSION_ID, toolName: 'mcp__github__list_issues' },
  },
  {
    adapter: ompAdapter,
    kind: 'pre-tool-use',
    label: 'omp known tool',
    payload: { sessionId: SESSION_ID, toolName: 'edit' },
  },
  {
    adapter: ompAdapter,
    kind: 'pre-tool-use',
    label: 'omp unknown tool',
    payload: { sessionId: SESSION_ID, toolName: 'some_future_tool' },
  },
  {
    adapter: ompAdapter,
    kind: 'pre-tool-use',
    label: 'omp mcp',
    payload: { sessionId: SESSION_ID, toolName: 'mcp__github__list_issues' },
  },
];

describe('tool-category conformance — every adapter, every case', () => {
  for (const { adapter, kind, label, payload } of CASES) {
    it(`${label} emits a taxonomy-conformant, schema-conformant event`, () => {
      const ev = adapter.mapPayload(kind, payload);
      expect(conformanceErrors(ev)).toEqual([]);
      expect(ev.tool?.category).toBeDefined();
      expect(TOOL_CATEGORIES).toContain(ev.tool?.category as (typeof TOOL_CATEGORIES)[number]);
    });
  }

  it('never emits the retired flat categories (builtin) for a real tool call', () => {
    for (const { adapter, kind, payload } of CASES) {
      const ev = adapter.mapPayload(kind, payload);
      expect(ev.tool?.category).not.toBe('builtin');
    }
  });
});
