import type { Event, EventType, ToolInfo } from '@ai-agents-observability/schemas';

import { clientInfo } from './client-info';
import { userIdClaim } from './identity';
import { uuidv7 } from './uuid';

// Subset of fields Claude Code sends on every hook event. We pass the rest
// through in `metadata` so the flusher can decide what to keep.
type ClaudeCodeHookPayload = {
  cwd?: unknown;
  hook_event_name?: unknown;
  session_id?: unknown;
  tool_input?: unknown;
  tool_name?: unknown;
  tool_response?: unknown;
  transcript_path?: unknown;
} & Record<string, unknown>;

const KNOWN_KEYS = new Set([
  'cwd',
  'hook_event_name',
  'session_id',
  'tool_input',
  'tool_name',
  'tool_response',
  'transcript_path',
]);

export type HookKind =
  | 'session-start'
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'stop'
  | 'user-prompt-submit'
  | 'pre-compact'
  | 'subagent-stop'
  | 'notification';

const HOOK_KIND_TO_EVENT_TYPE: Record<HookKind, EventType> = {
  notification: 'Notification',
  'post-tool-use': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-start': 'SessionStart',
  stop: 'Stop',
  'subagent-stop': 'SubagentStop',
  'user-prompt-submit': 'UserPromptSubmit',
};

export function isHookKind(value: string): value is HookKind {
  return value in HOOK_KIND_TO_EVENT_TYPE;
}

function pickMetadata(payload: ClaudeCodeHookPayload): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!KNOWN_KEYS.has(key)) {
      meta[key] = value;
    }
  }
  if (typeof payload.transcript_path === 'string') {
    meta.transcript_path = payload.transcript_path;
  }
  if (typeof payload.tool_name === 'string') {
    meta.tool_name = payload.tool_name;
  }
  return meta;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Translate a Claude Code tool payload into the structured `tool` block. Only the
// cheap, capture-time-knowable fields are filled (name, mcp split, byte sizes);
// duration/exit/denied aren't known at hook time and fall back to schema
// defaults on the ingest side. Kept allocation-light to respect the hot-path
// budget (the largest cost is stringifying tool_input, which stdin already caps
// at ~1 MB).
function buildToolInfo(raw: ClaudeCodeHookPayload): ToolInfo {
  const name = asString(raw.tool_name, 'unknown');

  let mcpServer: string | null = null;
  let mcpTool: string | null = null;
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep >= 0) {
      mcpServer = rest.slice(0, sep);
      mcpTool = rest.slice(sep + 2);
    }
  }

  const inputStr = raw.tool_input === undefined ? '' : JSON.stringify(raw.tool_input);
  const response = raw.tool_response;
  const outputStr =
    response === undefined
      ? ''
      : typeof response === 'string'
        ? response
        : JSON.stringify(response);
  const subagentType =
    name === 'Task' && isRecord(raw.tool_input) && typeof raw.tool_input.subagent_type === 'string'
      ? raw.tool_input.subagent_type
      : null;

  return {
    category: mcpServer ? 'mcp' : 'builtin',
    duration_ms: 0,
    exit_status: null,
    input_bytes: Buffer.byteLength(inputStr, 'utf8'),
    input_hash: null,
    mcp_server: mcpServer,
    mcp_tool: mcpTool,
    name,
    output_bytes: Buffer.byteLength(outputStr, 'utf8'),
    skill: null,
    slash_command: null,
    subagent_type: subagentType,
    was_denied: false,
    was_interrupted: false,
  };
}

// Translate Claude Code's hook payload into our Event shape. We deliberately
// keep this dependency-free of zod parsing on the hot path: the flusher
// re-validates with EventSchema before posting. Reliability > completeness.
export function toEvent(kind: HookKind, raw: ClaudeCodeHookPayload): Event {
  const sessionId = asString(raw.session_id, '00000000-0000-0000-0000-000000000000');
  const cwd = asString(raw.cwd, process.cwd());
  const eventType = HOOK_KIND_TO_EVENT_TYPE[kind];
  // PreToolUse/PostToolUse require a `tool` block (EventSchema discriminated
  // union); emit it from the raw payload so tool_name and tool-call counts are
  // populated downstream rather than lost in metadata.
  const isToolEvent = eventType === 'PreToolUse' || eventType === 'PostToolUse';

  return {
    agent_type: 'claude-code',
    client: clientInfo(),
    event_id: uuidv7(),
    event_type: eventType,
    metadata: pickMetadata(raw),
    redaction_flags: [],
    schema_version: 1,
    session_context: {
      cwd,
      // Git context is enriched by the flusher (P1-021) or session-start cache,
      // not on every event — keeps the hot path under budget.
      git: null,
      is_resume: false,
      mode: 'normal',
    },
    session_id: sessionId,
    ...(isToolEvent ? { tool: buildToolInfo(raw) } : {}),
    ts: new Date().toISOString(),
    user_id_claim: userIdClaim(),
  } as Event;
}
