import {
  canonicalPermissionMode,
  classifyNotification,
  type Event,
  type EventType,
  type ToolInfo,
} from '@ai-agents-observability/schemas';

import { fieldBytes } from './bytes';
import { clientInfo } from './client-info';
import { userIdClaim } from './identity';
import { uuidv7 } from './uuid';

// Subset of fields Claude Code sends on every hook event. We pass the rest
// through in `metadata` so the flusher can decide what to keep.
type ClaudeCodeHookPayload = {
  cwd?: unknown;
  hook_event_name?: unknown;
  message?: unknown;
  notification_type?: unknown;
  permission_mode?: unknown;
  prompt?: unknown;
  session_id?: unknown;
  tool_input?: unknown;
  tool_name?: unknown;
  tool_response?: unknown;
  transcript_path?: unknown;
} & Record<string, unknown>;

// `permission_mode` is captured structurally into session_context.mode, so it is
// a known key (not duplicated into metadata). `notification_type` / `message` are
// intentionally left out of KNOWN_KEYS so they pass through to metadata as the raw
// record alongside the derived `notification_kind`.
const KNOWN_KEYS = new Set([
  'cwd',
  'hook_event_name',
  'permission_mode',
  'prompt',
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

  const isMcp = name.startsWith('mcp__');
  let mcpServer: string | null = null;
  let mcpTool: string | null = null;
  if (isMcp) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep >= 0) {
      mcpServer = rest.slice(0, sep);
      mcpTool = rest.slice(sep + 2);
    }
  }

  const subagentType =
    name === 'Task' && isRecord(raw.tool_input) && typeof raw.tool_input.subagent_type === 'string'
      ? raw.tool_input.subagent_type
      : null;

  // Skill names equal their slash command (e.g. "deep-research" ↔ /deep-research).
  const skill =
    name === 'Skill' && isRecord(raw.tool_input) && typeof raw.tool_input.skill === 'string'
      ? raw.tool_input.skill
      : null;

  return {
    // Categorize by the mcp__ prefix, not the parse result: a name like
    // `mcp__server` (no tool segment) is still an MCP tool.
    category: isMcp ? 'mcp' : 'builtin',
    duration_ms: 0,
    exit_status: null,
    input_bytes: fieldBytes(raw.tool_input),
    input_hash: null,
    mcp_server: mcpServer,
    mcp_tool: mcpTool,
    name,
    output_bytes: fieldBytes(raw.tool_response),
    skill,
    slash_command: skill,
    subagent_type: subagentType,
    // Best-effort from the raw payload (absent → false). Unknown payload fields
    // are also preserved verbatim in `metadata`, so nothing is lost.
    was_denied: raw.tool_denied === true || raw.was_denied === true,
    was_interrupted: raw.was_interrupted === true,
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
  // populated downstream rather than lost in metadata. The `as Event` cast is
  // unavoidable here: `event_type` is a dynamic (non-literal) value, which
  // TypeScript can't assign to a discriminated union without it. The safety net
  // is ingest-side EventSchema validation plus the schema's own enforcement
  // tests — a tool event reaching ingest without a tool block is rejected.
  const isToolEvent = eventType === 'PreToolUse' || eventType === 'PostToolUse';

  const metadata = pickMetadata(raw);
  if (eventType === 'UserPromptSubmit' && typeof raw.prompt === 'string') {
    const match = /^\/([a-zA-Z][\w-]*)/.exec(raw.prompt.trimStart());
    if (match) {
      metadata.slash_command = match[1];
    }
  }
  // Classify the moment the agent stops to get the human's attention. The raw
  // notification_type / message stay in metadata (passed through above); we add a
  // normalized kind ingest can aggregate without re-parsing.
  if (eventType === 'Notification') {
    metadata.notification_kind = classifyNotification(raw.notification_type, raw.message);
  }

  return {
    agent_type: 'CLAUDE_CODE',
    client: clientInfo(),
    event_id: uuidv7(),
    event_type: eventType,
    metadata,
    redaction_flags: [],
    schema_version: 1,
    session_context: {
      cwd,
      // Git context is enriched by the flusher (P1-021) or session-start cache,
      // not on every event — keeps the hot path under budget.
      git: null,
      is_resume: false,
      // Permission/autonomy mode the human granted, straight from Claude Code's
      // hook payload. Falls back to 'normal' when absent (older agents/events).
      mode: canonicalPermissionMode(raw.permission_mode),
    },
    session_id: sessionId,
    ...(isToolEvent ? { tool: buildToolInfo(raw) } : {}),
    ts: new Date().toISOString(),
    user_id_claim: userIdClaim(),
  } as Event;
}
