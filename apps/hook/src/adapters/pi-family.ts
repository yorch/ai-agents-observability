import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Event, EventType, ToolInfo } from '@ai-agents-observability/schemas';

import { fieldBytes } from '../lib/bytes';
import { clientInfo } from '../lib/client-info';
import { userIdClaim } from '../lib/identity';
import { sessionUuid } from '../lib/session-id';
import { uuidv7 } from '../lib/uuid';
import type { AdapterInstallConfig, ConformantEvent, HookAdapter, TranscriptTarget } from './index';

// Shared implementation for the Pi family — Pi and OMP (P12-007, P12-008).
//
// OMP is a fork of Pi, and it shows: both drive telemetry through in-process
// TypeScript extension modules (NOT stdin command hooks, so the stdin-hook factory
// does not apply), both use the same event vocabulary — `session_start`,
// `before_agent_start`, `tool_call`, `tool_result`, `turn_end`,
// `session_before_compact`, `session_shutdown` — and both store one session as a
// single JSONL file with per-message token usage and cost.
//
// That last property is why these two are the best-shaped agents we capture:
// `transcriptTarget()` works on day one, unlike opencode's directory storage.
//
// The extension we install (see each adapter's install snippet) is what actually
// shapes the payload, so the readers below accept the spellings that extension
// sends plus the plausible native ones. Where a field name is inferred rather than
// documented, it is marked.

/** Event vocabulary shared by Pi and OMP. */
export const PI_FAMILY_EVENT_TYPE: Record<string, EventType> = {
  'post-tool-use': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
  stop: 'Stop',
  'subagent-stop': 'SubagentStop',
  'user-prompt-submit': 'UserPromptSubmit',
};

/** Native event name → our hook kind. The extension snippets use this mapping. */
export const PI_FAMILY_NATIVE_EVENTS: Record<string, string> = {
  before_agent_start: 'user-prompt-submit',
  session_before_compact: 'pre-compact',
  session_shutdown: 'session-end',
  session_start: 'session-start',
  tool_call: 'pre-tool-use',
  tool_result: 'post-tool-use',
  turn_end: 'stop',
};

export type PiFamilyConfig = {
  agentType: string;
  /** Where sessions live, e.g. `~/.pi/agent/sessions`. First existing root wins. */
  sessionRoots(): string[];
  install: Omit<AdapterInstallConfig, 'hookKinds'>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function firstOf(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) {
      return raw[key];
    }
  }
  return null;
}

const SESSION_ID_KEYS = ['sessionId', 'session_id', 'sessionID', 'id'];
const CWD_KEYS = ['cwd', 'directory', 'workingDirectory', 'working_directory'];
const TOOL_NAME_KEYS = ['toolName', 'tool_name', 'tool', 'name'];
const TOOL_INPUT_KEYS = ['args', 'toolArgs', 'tool_input', 'input', 'arguments'];
const TOOL_OUTPUT_KEYS = ['result', 'toolResult', 'tool_response', 'output'];
const MODEL_KEYS = ['model', 'modelId', 'modelID'];
const USAGE_KEYS = ['usage', 'tokens', 'tokenUsage'];

// The structural keys; everything else on the payload rides along in metadata.
const KNOWN_KEYS = new Set([
  ...SESSION_ID_KEYS,
  ...CWD_KEYS,
  ...TOOL_NAME_KEYS,
  ...TOOL_INPUT_KEYS,
  ...TOOL_OUTPUT_KEYS,
  ...USAGE_KEYS,
  'sessionFile',
  'session_file',
  'transcript_path',
]);

function buildToolInfo(raw: Record<string, unknown>): ToolInfo {
  const name = str(firstOf(raw, TOOL_NAME_KEYS), 'unknown');
  const input = firstOf(raw, TOOL_INPUT_KEYS);
  const output = firstOf(raw, TOOL_OUTPUT_KEYS);
  const isMcp = name.startsWith('mcp__') || name.includes('__');

  return {
    category: isMcp ? 'mcp' : 'builtin',
    duration_ms: num(raw.durationMs ?? raw.duration_ms),
    exit_status: typeof raw.exitStatus === 'number' ? raw.exitStatus : null,
    input_bytes: fieldBytes(input),
    input_hash: null,
    mcp_server: null,
    mcp_tool: null,
    name,
    output_bytes: fieldBytes(output),
    skill: null,
    slash_command: null,
    // Both agents support subagents; the extension forwards the subagent's name
    // when the event carries one.
    subagent_type: typeof raw.subagentType === 'string' ? raw.subagentType : null,
    was_denied: raw.denied === true || raw.blocked === true,
    was_interrupted: raw.interrupted === true || raw.aborted === true,
  };
}

// ── Usage ─────────────────────────────────────────────────────────────────────

// Pi and OMP both record per-message usage — input/output tokens, cache
// read/write, and a cost breakdown — on assistant messages in the session JSONL.
// The extension forwards it on `turn_end` when the event exposes it; the field
// names below cover both agents' documented `Usage` shape and the generic
// spellings. Cost is deliberately NOT read from the agent: ingest recomputes it
// from the per-agent price table (P8-002), and agent-reported cost crosses
// P8-006's reconciliation design.
function buildLlm(raw: Record<string, unknown>): Event['llm'] | undefined {
  const usage = [firstOf(raw, USAGE_KEYS)].find(isRecord);
  const model = str(firstOf(raw, MODEL_KEYS), '');
  if (!usage) {
    return undefined;
  }
  const cache = isRecord(usage.cache) ? usage.cache : {};
  const input = num(usage.input ?? usage.inputTokens ?? usage.input_tokens);
  const output = num(usage.output ?? usage.outputTokens ?? usage.output_tokens);
  const cacheRead = num(cache.read ?? usage.cacheRead ?? usage.cache_read_tokens);
  const cacheWrite = num(cache.write ?? usage.cacheWrite ?? usage.cache_creation_tokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    return undefined;
  }
  return {
    cache_creation_tokens: cacheWrite,
    cache_read_tokens: cacheRead,
    cost_usd: 0, // computed ingest-side from the agent's price table
    input_tokens: input,
    model: model.length > 0 ? model : 'unknown',
    output_tokens: output,
  };
}

// ── Session file ──────────────────────────────────────────────────────────────

/**
 * The session's JSONL transcript. Both agents name the file after the session id
 * (`<timestamp>_<sessionId>.jsonl`) inside a per-working-directory folder, so an
 * explicit path from the extension is preferred and a bounded scan is the
 * fallback. Never throws — a missing transcript is not a failed hook.
 */
export function locateSessionFile(roots: string[], nativeSessionId: string | null): string | null {
  const explicitRoots = roots.filter((root) => existsSync(root));
  if (explicitRoots.length === 0 || !nativeSessionId) {
    return null;
  }
  const candidates: { mtime: number; path: string }[] = [];
  for (const root of explicitRoots) {
    collectJsonl(root, nativeSessionId, candidates, 0);
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null;
}

function collectJsonl(
  dir: string,
  sessionId: string,
  out: { mtime: number; path: string }[],
  depth: number,
): void {
  if (depth > 3) {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectJsonl(full, sessionId, out, depth + 1);
    } else if (name.endsWith('.jsonl') && name.includes(sessionId)) {
      out.push({ mtime: st.mtimeMs, path: full });
    }
  }
}

/**
 * Last usage recorded in a session JSONL, for turns where the extension could not
 * forward it. Reads the tail only.
 *
 * CAUTION: the per-entry nesting (`entry.message.usage`) is inferred from the
 * documented session format rather than from a verified sample. Unrecognized
 * shapes yield null — a Stop with no `llm` block, never a wrong number.
 */
export function usageFromSessionFile(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 200; i--) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const record = safeJsonObject(line);
    if (!record) {
      continue;
    }
    const message = isRecord(record.message) ? record.message : record;
    const usage = isRecord(message.usage) ? message.usage : null;
    if (usage) {
      const model = firstOf(message, MODEL_KEYS) ?? firstOf(record, MODEL_KEYS);
      return { model, usage };
    }
  }
  return null;
}

/**
 * Parse one JSONL line into an object, tolerating a leading preamble — OMP files
 * open with a fixed-width title slot, so the first "line" can be padding followed
 * by the session header.
 */
export function safeJsonObject(line: string): Record<string, unknown> | null {
  const attempts = [line];
  const brace = line.indexOf('{');
  if (brace > 0) {
    attempts.push(line.slice(brace));
  }
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (isRecord(parsed) && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next attempt
    }
  }
  return null;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export function createPiFamilyAdapter(config: PiFamilyConfig): HookAdapter {
  const nativeSessionId = (raw: Record<string, unknown>): string | null => {
    const value = firstOf(raw, SESSION_ID_KEYS);
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const explicitTranscript = (raw: Record<string, unknown>): string | null => {
    const value = firstOf(raw, ['sessionFile', 'session_file', 'transcript_path']);
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const mapPayload = (kind: string, raw: Record<string, unknown>): ConformantEvent => {
    const eventType = PI_FAMILY_EVENT_TYPE[kind] ?? 'Notification';
    const isToolEvent = eventType === 'PreToolUse' || eventType === 'PostToolUse';

    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!KNOWN_KEYS.has(key)) {
        metadata[key] = value;
      }
    }

    let llm = eventType === 'Stop' ? buildLlm(raw) : undefined;
    if (eventType === 'Stop' && !llm) {
      // The extension could not forward usage; fall back to the session file.
      const native = nativeSessionId(raw);
      const path = explicitTranscript(raw) ?? locateSessionFile(config.sessionRoots(), native);
      const recovered = path ? usageFromSessionFile(path) : null;
      llm = recovered ? buildLlm(recovered) : undefined;
    }

    return {
      agent_type: config.agentType,
      client: clientInfo(),
      event_id: uuidv7(),
      event_type: eventType,
      ...(llm ? { llm } : {}),
      metadata,
      redaction_flags: [],
      schema_version: 1,
      session_context: {
        cwd: str(firstOf(raw, CWD_KEYS), process.cwd()),
        git: null,
        is_resume: false,
        mode: 'normal',
      },
      session_id: sessionUuid(config.agentType, nativeSessionId(raw)),
      ...(isToolEvent ? { tool: buildToolInfo(raw) } : {}),
      ts: new Date().toISOString(),
      user_id_claim: userIdClaim(),
    } as ConformantEvent;
  };

  return {
    agentType: config.agentType,

    installConfig(): AdapterInstallConfig {
      return { ...config.install, hookKinds: Object.keys(PI_FAMILY_EVENT_TYPE) };
    },

    isHookKind(value: string): boolean {
      return value in PI_FAMILY_EVENT_TYPE;
    },

    mapPayload,

    // Single-file JSONL per session, so this works on day one — the property
    // opencode lacks (P8-004) and the reason these two adapters were worth doing
    // before closing that gap.
    transcriptTarget(kind: string, raw: Record<string, unknown>): TranscriptTarget | null {
      const eventType = PI_FAMILY_EVENT_TYPE[kind];
      if (eventType !== 'Stop' && eventType !== 'SessionEnd') {
        return null;
      }
      const native = nativeSessionId(raw);
      const path = explicitTranscript(raw) ?? locateSessionFile(config.sessionRoots(), native);
      if (!path) {
        return null;
      }
      return { sessionId: sessionUuid(config.agentType, native), transcriptPath: path };
    },
  };
}

/** `$XDG`-less home resolution shared by both adapters' default session roots. */
export function homeDir(): string {
  return homedir();
}
