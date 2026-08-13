import type { EventType, ToolInfo } from '@ai-agents-observability/schemas';

import type { HookAdapter } from './index';
import {
  buildGenericToolInfo,
  createStdinHookAdapter,
  type FieldAliases,
} from './stdin-hook-factory';

// GitHub Copilot CLI adapter (P12-006). Copilot's hooks are a versioned JSON
// document — `{ version: 1, hooks: { <event>: [{ type: "command", … }] } }` —
// discovered from a layered set of locations (`~/.copilot/hooks/`,
// `.github/hooks/*.json`, `~/.copilot/settings.json`, policy dirs, plugins). The
// payload is Claude-shaped, so capture is the stdin-hook factory plus two
// Copilot-specific wrinkles:
//
//   1. Fields are camelCase (`sessionId`, `toolName`, `toolArgs`, `toolResult`),
//      but Copilot documents PascalCase event aliases whose payloads use the
//      snake_case spellings — so every field is read under BOTH spellings rather
//      than betting on one.
//   2. `preToolUse` command hooks are FAIL-CLOSED: a crash or non-zero exit denies
//      the tool call. Our binary already exits 0 unconditionally (hook-entry.ts
//      swallows everything) — that invariant is load-bearing for this agent in a
//      way it is not for the others. Do not "improve" it.
//
// Lifecycle mapping (copilot event → canonical EventType):
//   sessionStart / sessionEnd    → SessionStart / SessionEnd
//   userPromptSubmitted          → UserPromptSubmit
//   preToolUse / postToolUse     → PreToolUse / PostToolUse
//   postToolUseFailure           → PostToolUse (with a non-zero exit_status)
//   preCompact                   → PreCompact
//   agentStop                    → Stop
//   subagentStop                 → SubagentStop
//   notification                 → Notification
// userPromptTransformed, permissionRequest, subagentStart and errorOccurred have
// no canonical equivalent and are dropped rather than mapped to an invented type.

const COPILOT_EVENT_TYPE: Record<string, EventType> = {
  'agent-stop': 'Stop',
  notification: 'Notification',
  'post-tool-use': 'PostToolUse',
  // Same canonical type as a success; the failure shows up as exit_status.
  'post-tool-use-failure': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
  'subagent-stop': 'SubagentStop',
  'user-prompt-submitted': 'UserPromptSubmit',
};

const HOOK_KIND_TO_COPILOT_EVENT: Record<string, string> = {
  'agent-stop': 'agentStop',
  notification: 'notification',
  'post-tool-use': 'postToolUse',
  'post-tool-use-failure': 'postToolUseFailure',
  'pre-compact': 'preCompact',
  'pre-tool-use': 'preToolUse',
  'session-end': 'sessionEnd',
  'session-start': 'sessionStart',
  'subagent-stop': 'subagentStop',
  'user-prompt-submitted': 'userPromptSubmitted',
};

// Both spellings of every field, native first.
const COPILOT_FIELDS: Partial<FieldAliases> = {
  cwd: ['cwd'],
  sessionId: ['sessionId', 'session_id'],
  toolInput: ['toolArgs', 'tool_input'],
  toolName: ['toolName', 'tool_name'],
  toolResponse: ['toolResult', 'tool_response'],
};

// The alias keys are known automatically (the factory unions them in); nothing
// extra is captured structurally for Copilot, so `error` and `timestamp` ride
// along in metadata.
const COPILOT_KNOWN_KEYS: string[] = [];

/** Truthy, non-empty error content — not merely a present `error` key. */
function hasError(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).length > 0;
  }
  return value === true;
}

function buildCopilotToolInfo(
  raw: Record<string, unknown>,
  aliases: FieldAliases,
  kind: string,
): ToolInfo {
  const tool = buildGenericToolInfo(raw, aliases, kind);
  // postToolUseFailure carries the same tool fields plus an error; fold it into
  // PostToolUse with a non-zero exit rather than inventing an event type.
  //
  // The KIND is authoritative — a failure payload need not restate
  // `hook_event_name`, and sniffing the payload alone recorded such calls as
  // successes. The error-content check is a secondary signal, and it tests for
  // real content: payloads that always carry `error` (null/false/"" on success)
  // would otherwise mark every call failed.
  const nestedError =
    typeof raw.toolResult === 'object' && raw.toolResult !== null
      ? (raw.toolResult as Record<string, unknown>).error
      : undefined;
  if (kind === 'post-tool-use-failure' || hasError(raw.error) || hasError(nestedError)) {
    tool.exit_status = 1;
  }
  return tool;
}

// Copilot's own `timestamp` is a number in the camelCase form and an ISO-8601
// string in the PascalCase alias form. We stamp `ts` at capture time from the
// local clock either way; the agent's value rides along in metadata untouched, so
// neither encoding is lost or misparsed.

function renderSnippet(bin: string): string {
  const hooks: Record<string, unknown[]> = {};
  for (const [kind, copilotEvent] of Object.entries(HOOK_KIND_TO_COPILOT_EVENT)) {
    hooks[copilotEvent] = [
      {
        // Cross-platform `command` form (argv array) rather than `bash`, so the
        // same document works on Windows and a path with spaces is not split.
        command: [bin, 'hook', kind, '--agent', 'copilot'],
        timeoutSec: 5,
        type: 'command',
      },
    ];
  }
  return JSON.stringify({ disableAllHooks: false, hooks, version: 1 }, null, 2);
}

export const copilotAdapter: HookAdapter = createStdinHookAdapter({
  agentType: 'COPILOT',
  buildTool: buildCopilotToolInfo,
  eventMap: COPILOT_EVENT_TYPE,
  fields: COPILOT_FIELDS,
  install: {
    agentName: 'GitHub Copilot CLI',
    renderSnippet,
    settingsHint: 'Write this to ~/.copilot/hooks/claude-telemetry.json:',
  },
  knownKeys: COPILOT_KNOWN_KEYS,
  // Copilot's documented payload carries no transcript path, so nothing to ship —
  // the opencode precedent. If a session log location turns out to be
  // discoverable, that is a follow-up, not a blocker.
});
