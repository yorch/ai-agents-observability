import type { Event, EventType } from '@ai-agents-observability/schemas';

import { clientInfo } from './client-info.js';
import { userIdClaim } from './identity.js';
import { uuidv7 } from './uuid.js';

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
  'notification': 'Notification',
  'post-tool-use': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-start': 'SessionStart',
  'stop': 'Stop',
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

// Translate Claude Code's hook payload into our Event shape. We deliberately
// keep this dependency-free of zod parsing on the hot path: the flusher
// re-validates with EventSchema before posting. Reliability > completeness.
export function toEvent(kind: HookKind, raw: ClaudeCodeHookPayload): Event {
  const sessionId = asString(raw.session_id, '00000000-0000-0000-0000-000000000000');
  const cwd = asString(raw.cwd, process.cwd());

  return {
    agent_type: 'claude-code',
    client: clientInfo(),
    event_id: uuidv7(),
    event_type: HOOK_KIND_TO_EVENT_TYPE[kind],
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
    ts: new Date().toISOString(),
    user_id_claim: userIdClaim(),
  };
}
