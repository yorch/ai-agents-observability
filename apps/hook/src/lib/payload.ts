import {
  classifyNotification,
  type EventType,
  type ToolInfo,
  toolActionFor,
  toolCategory,
  toolTargetHash,
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
  // Claude Code's own per-call id (`toolu_…`), REQUIRED on PreToolUse and
  // PostToolUse in the hook input contract. It is the join key P14-006 uses.
  tool_use_id?: unknown;
  transcript_path?: unknown;
} & Record<string, unknown>;

// `permission_mode` is captured structurally into session_context.mode, so it is
// a known key (not duplicated into metadata). `notification_type` is intentionally
// left out so it passes through to metadata as the raw record alongside the derived
// `notification_kind`.
//
// This list is NOT the privacy boundary and never was — it is "captured elsewhere,
// don't duplicate". The boundary is `admitsToMetadata`
// (packages/schemas/src/metadata-safety.ts), applied to every key this list does
// not name. Reading it as the boundary is what let Claude Code's
// `last_assistant_message` — a Stop/SubagentStop field its own hook schema
// describes as "Text content of the last assistant message before stopping" —
// land in `events.metadata` unredacted (P14-008). Its stablemates on the same
// hooks (`custom_instructions`, `session_title`, `compact_summary`,
// `background_tasks[].description`) are refused by the same rule, and so is the
// notification `message` that used to ride through here.
export const CLAUDE_KNOWN_KEYS = [
  'cwd',
  'hook_event_name',
  'permission_mode',
  'prompt',
  'session_id',
  'tool_input',
  'tool_name',
  'tool_response',
  // Captured structurally onto the tool block since P14-006. Before that it fell
  // through to `metadata` as an unknown key — which is how the join key turned
  // out to have been on the wire all along, simply unpromoted.
  'tool_use_id',
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
    // Coarse command class + non-reversible target digest (P13-003). Both read
    // only the small target/command field of tool_input — never the whole input,
    // never the output — so the hot-path cost is a pass over a path-length
    // string, not over the ~1 MB stdin cap.
    action: toolActionFor(raw.tool_input),
    // Categorize by the mcp__ prefix, not the parse result: a name like
    // `mcp__server` (no tool segment) is still an MCP tool — pass `isMcp`
    // itself through rather than `mcpServer`, which is null in exactly that case.
    category: toolCategory('CLAUDE_CODE', name, isMcp),
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
    target_hash: toolTargetHash(raw.tool_input),
    // Claude Code's own id for this call. Copied verbatim, never parsed — it is
    // matched against the SAME string on the transcript's `tool_use` block, so
    // any normalization here would break the one thing it is for (P14-006).
    tool_use_id:
      typeof raw.tool_use_id === 'string' && raw.tool_use_id.length > 0 ? raw.tool_use_id : null,
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
