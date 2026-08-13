import {
  classifyNotification,
  type EventType,
  type ToolInfo,
} from '@ai-agents-observability/schemas';

import { fieldBytes } from './bytes';

// Claude Code's payload specifics. Generic assembly (session id, cwd, metadata
// passthrough, permission mode, transcript target) moved to the stdin-hook factory
// in P12-003 — what stays here is what is genuinely Claude's: its hook-kind list,
// its Task/Skill tool semantics, and its notification/slash-command enrichment.
//
// `adapters/claude-code.ts` wires these into the factory. Nothing else should.

// Subset of fields Claude Code sends on every hook event. We pass the rest
// through in `metadata` so the flusher can decide what to keep.
export type ClaudeCodeHookPayload = {
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
export const CLAUDE_KNOWN_KEYS = [
  'cwd',
  'hook_event_name',
  'permission_mode',
  'prompt',
  'session_id',
  'tool_input',
  'tool_name',
  'tool_response',
  'transcript_path',
];

export type HookKind =
  | 'session-start'
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'stop'
  | 'user-prompt-submit'
  | 'pre-compact'
  | 'subagent-stop'
  | 'notification';

export const HOOK_KIND_TO_EVENT_TYPE: Record<HookKind, EventType> = {
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
export function buildClaudeToolInfo(raw: ClaudeCodeHookPayload): ToolInfo {
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

/**
 * Claude-derived metadata: the slash command a prompt opens with, and a normalized
 * notification kind. The raw `notification_type` / `message` stay in metadata
 * (passed through generically); this adds what ingest can aggregate without
 * re-parsing.
 */
export function enrichClaudeMetadata(
  metadata: Record<string, unknown>,
  eventType: EventType,
  raw: ClaudeCodeHookPayload,
): void {
  if (eventType === 'UserPromptSubmit' && typeof raw.prompt === 'string') {
    const match = /^\/([a-zA-Z][\w-]*)/.exec(raw.prompt.trimStart());
    if (match) {
      metadata.slash_command = match[1];
    }
  }
  if (eventType === 'Notification') {
    metadata.notification_kind = classifyNotification(raw.notification_type, raw.message);
  }
}
