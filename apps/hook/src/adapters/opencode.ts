import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Event, EventType, ToolInfo } from '@ai-agents-observability/schemas';

import { fieldBytes } from '../lib/bytes';
import { clientInfo } from '../lib/client-info';
import { userIdClaim } from '../lib/identity';
import { sessionUuid } from '../lib/session-id';
import { uuidv7 } from '../lib/uuid';
import type { AdapterInstallConfig, ConformantEvent, HookAdapter, TranscriptTarget } from './index';

// opencode adapter (P8-004) — the validating SECOND HookAdapter, used to confirm
// the seam from P8-003 holds for an agent that is not Claude Code.
//
// opencode (https://opencode.ai, open-source) drives telemetry through its plugin
// event bus. A thin opencode plugin shells out to `claude-telemetry hook <kind>
// --agent opencode`, piping the event JSON on stdin — the same transport contract
// the Claude Code hook uses. This adapter translates opencode's event payloads
// into the canonical ConformantEvent shape; the transport (queue/flusher/shipper)
// is unchanged and carries no opencode-specific code.
//
// Lifecycle mapping (opencode event → canonical EventType):
//   session-start       → SessionStart   (session.created)
//   user-prompt-submit  → UserPromptSubmit (chat.message, role=user)
//   pre-tool-use        → PreToolUse     (tool.execute.before)
//   post-tool-use       → PostToolUse    (tool.execute.after)
//   session-idle        → Stop           (session.idle — assistant finished)
//   session-end         → SessionEnd     (session.deleted / process exit)
// opencode events with no canonical equivalent are dropped by the plugin (not
// invented here) — we never synthesize a non-schema event_type.

const OPENCODE_EVENT_TYPE: Record<string, EventType> = {
  'post-tool-use': 'PostToolUse',
  'pre-tool-use': 'PreToolUse',
  'session-end': 'SessionEnd',
  'session-idle': 'Stop',
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
};

// opencode's storage root. Sessions live under
// `<root>/storage/session/<projectId>/<sessionId>.json` with the conversation
// itself in sibling per-message directories named after the session id, so we
// locate BY NAME at bounded depth rather than hard-coding a layout that has
// already changed once since P8-004.
function opencodeStorageRoot(): string {
  if (process.env.OPENCODE_DATA) {
    return process.env.OPENCODE_DATA;
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'storage');
}

/** The directory holding this session's records, or null. Never throws. */
export function locateSessionStorage(sessionId: string): string | null {
  const root = opencodeStorageRoot();
  if (!existsSync(root)) {
    return null;
  }
  return findDirNamed(root, sessionId, 0);
}

function findDirNamed(dir: string, name: string, depth: number): string | null {
  if (depth > 3) {
    return null;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === name) {
      return join(dir, entry.name);
    }
    const nested = findDirNamed(join(dir, entry.name), name, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Build the structured `tool` block from an opencode tool event. opencode tool
// names are bare (`bash`, `edit`, `read`) or `<provider>_<tool>` for plugins;
// the agent_type prefix that disambiguates `opencode:Edit` from `claude_code:Edit`
// (P8-001) is applied at QUERY time, not here, so names stay raw.
function buildToolInfo(raw: Record<string, unknown>): ToolInfo {
  const name = str(raw.tool ?? raw.tool_name, 'unknown');
  const input = raw.args ?? raw.tool_input ?? null;
  const output = raw.result ?? raw.output ?? raw.tool_response ?? null;

  return {
    category: 'builtin',
    duration_ms: num(raw.duration_ms),
    exit_status: typeof raw.exit_status === 'number' ? raw.exit_status : null,
    input_bytes: fieldBytes(input),
    input_hash: null,
    mcp_server: null,
    mcp_tool: null,
    name,
    output_bytes: fieldBytes(output),
    skill: null,
    slash_command: null,
    subagent_type: null,
    was_denied: raw.denied === true || raw.was_denied === true,
    was_interrupted: raw.was_interrupted === true,
  };
}

// opencode events can carry model + token usage (its plugin exposes usage on the
// assistant message). When present, attach an `llm` block so ingest prices the
// usage against the opencode price table (P8-002).
function buildLlm(raw: Record<string, unknown>): Event['llm'] | undefined {
  const model = raw.model ?? raw.modelID;
  if (typeof model !== 'string' || model.length === 0) {
    return undefined;
  }
  const usage = isRecord(raw.tokens) ? raw.tokens : isRecord(raw.usage) ? raw.usage : {};
  const cache = isRecord(usage.cache) ? usage.cache : {};
  return {
    cache_creation_tokens: num(usage.cache_creation ?? cache.write),
    cache_read_tokens: num(usage.cache_read ?? cache.read),
    cost_usd: 0, // computed ingest-side from the opencode price table
    input_tokens: num(usage.input),
    model,
    output_tokens: num(usage.output),
  };
}

function mapPayload(kind: string, raw: Record<string, unknown>): ConformantEvent {
  const eventType = OPENCODE_EVENT_TYPE[kind] ?? 'Notification';
  // opencode session ids are `ses_`-prefixed, NOT UUIDs. Passing them through
  // meant every real opencode event failed EventSchema at ingest and was dropped
  // (P12-002) — the adapter's own tests used UUID-shaped fixtures and never saw it.
  const sessionId = sessionUuid('OPENCODE', raw.sessionID ?? raw.session_id);
  const cwd = str(raw.directory ?? raw.cwd, process.cwd());
  const isToolEvent = eventType === 'PreToolUse' || eventType === 'PostToolUse';
  const llm = buildLlm(raw);

  return {
    agent_type: 'OPENCODE',
    client: clientInfo(),
    event_id: uuidv7(),
    event_type: eventType,
    ...(llm ? { llm } : {}),
    metadata: {},
    redaction_flags: [],
    schema_version: 1,
    session_context: {
      cwd,
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

function renderSnippet(bin: string): string {
  // opencode loads plugins from `.opencode/plugin/` (project) or
  // `~/.config/opencode/plugin/`. The plugin forwards bus events to this binary.
  return [
    '// ~/.config/opencode/plugin/telemetry.ts',
    "import type { Plugin } from '@opencode-ai/plugin';",
    'export const telemetry: Plugin = async () => ({',
    '  event: async ({ event }) => {',
    '    const map = {',
    "      'session.created': 'session-start',",
    "      'tool.execute.before': 'pre-tool-use',",
    "      'tool.execute.after': 'post-tool-use',",
    "      'session.idle': 'session-idle',",
    '    };',
    '    const kind = map[event.type];',
    '    if (!kind) return;',
    `    const p = Bun.spawn(['${bin}', 'hook', kind, '--agent', 'opencode'], { stdin: 'pipe' });`,
    '    p.stdin.write(JSON.stringify(event.properties ?? {}));',
    '    await p.stdin.end();',
    '  },',
    '});',
  ].join('\n');
}

export const opencodeAdapter: HookAdapter = {
  agentType: 'OPENCODE',

  installConfig(): AdapterInstallConfig {
    return {
      agentName: 'opencode',
      hookKinds: Object.keys(OPENCODE_EVENT_TYPE),
      renderSnippet,
      settingsHint: 'Add an opencode plugin (~/.config/opencode/plugin/telemetry.ts):',
    };
  },

  isHookKind(value: string): boolean {
    return value in OPENCODE_EVENT_TYPE;
  },

  mapPayload,

  // INTERFACE FINDING (P8-004), CLOSED IN P12-009: opencode stores conversation
  // history as a directory of per-message JSON under
  // ~/.local/share/opencode/storage, not a single .jsonl file like Claude Code.
  // The shipper reads a single file, so this returned null for a year.
  //
  // The fix is not in the interface — it stays `TranscriptTarget | null` — but in
  // the shipper, which now collates a DIRECTORY target into one JSONL before
  // reading it (lib/transcript-collate.ts). That rule is agent-neutral, and the
  // collation happens in the shipper process, never on the hook's hot path.
  transcriptTarget(kind: string, raw: Record<string, unknown>): TranscriptTarget | null {
    const eventType = OPENCODE_EVENT_TYPE[kind];
    if (eventType !== 'Stop' && eventType !== 'SessionEnd') {
      return null;
    }
    const native = raw.sessionID ?? raw.session_id;
    if (typeof native !== 'string' || native.length === 0) {
      return null;
    }
    const dir = locateSessionStorage(native);
    if (!dir) {
      return null;
    }
    return { sessionId: sessionUuid('OPENCODE', native), transcriptPath: dir };
  },
};
