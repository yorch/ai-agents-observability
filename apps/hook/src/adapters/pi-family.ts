import {
  closeSync,
  type Dirent,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Event, EventType, ToolInfo } from '@ai-agents-observability/schemas';

import { fieldBytes } from '../lib/bytes';
import { clientInfo } from '../lib/client-info';
import { isPlainRecord, isRecord, pickValue } from '../lib/fields';
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

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

// NOTE: `id` is deliberately NOT a session-id alias. Pi and omp put a per-entry
// id (`msg_0001`) on their event payloads, so accepting it would give every event
// of one session a different session_id — shattering the session into N
// one-event rows and breaking transcript lookup with it.
const SESSION_ID_KEYS = ['sessionId', 'session_id', 'sessionID'];
const CWD_KEYS = ['cwd', 'directory', 'workingDirectory', 'working_directory'];
const TOOL_NAME_KEYS = ['toolName', 'tool_name', 'tool', 'name'];
const TOOL_INPUT_KEYS = ['args', 'toolArgs', 'tool_input', 'input', 'arguments'];
const TOOL_OUTPUT_KEYS = ['result', 'toolResult', 'tool_response', 'output'];
const MODEL_KEYS = ['model', 'modelId', 'modelID'];
const USAGE_KEYS = ['usage', 'tokens', 'tokenUsage'];
const TRANSCRIPT_KEYS = ['sessionFile', 'session_file', 'transcript_path'];

// Keys captured structurally, per event kind — everything else rides along in
// metadata. This is kind-scoped because the tool/usage keys are only *read* on
// their own event kinds: stripping `name` or `result` from a SessionStart would
// drop a field nothing else captures.
const BASE_KNOWN_KEYS = [...SESSION_ID_KEYS, ...CWD_KEYS, ...TRANSCRIPT_KEYS];
const TOOL_KNOWN_KEYS = new Set([
  ...BASE_KNOWN_KEYS,
  ...TOOL_NAME_KEYS,
  ...TOOL_INPUT_KEYS,
  ...TOOL_OUTPUT_KEYS,
]);
const STOP_KNOWN_KEYS = new Set([...BASE_KNOWN_KEYS, ...USAGE_KEYS]);
const OTHER_KNOWN_KEYS = new Set(BASE_KNOWN_KEYS);

function buildToolInfo(raw: Record<string, unknown>): ToolInfo {
  const name = str(pickValue(raw, TOOL_NAME_KEYS), 'unknown');
  const input = pickValue(raw, TOOL_INPUT_KEYS);
  const output = pickValue(raw, TOOL_OUTPUT_KEYS);
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
  // Try every alias, not just the first present one: a payload carrying a scalar
  // `usage` alongside a real `tokenUsage` object must not stop at the scalar.
  const usage = USAGE_KEYS.map((key) => raw[key]).find(isRecord);
  const model = str(pickValue(raw, MODEL_KEYS), '');
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
  if (!nativeSessionId) {
    return null;
  }
  const cacheKey = `${roots.join('|')}::${nativeSessionId}`;
  const cached = locateMemo.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const found = locateSessionFileUncached(roots, nativeSessionId);
  locateMemo.set(cacheKey, found);
  return found;
}

// hook-entry calls transcriptTarget AND (on Stop) the usage fallback in the same
// process, so an unmemoized scan runs the whole directory walk twice per turn.
const locateMemo = new Map<string, string | null>();

// Bounds the scan so a developer with hundreds of project directories does not
// pay an unbounded walk on the hot path. Exceeding it means we return whatever
// matched so far rather than continuing.
const MAX_SCAN_ENTRIES = 5_000;

function locateSessionFileUncached(roots: string[], nativeSessionId: string): string | null {
  const explicitRoots = roots.filter((root) => existsSync(root));
  if (explicitRoots.length === 0) {
    return null;
  }
  const candidates: { mtime: number; path: string }[] = [];
  const budget = { scanned: 0 };
  for (const root of explicitRoots) {
    collectJsonl(root, nativeSessionId, candidates, 0, budget);
  }
  // Deterministic: newest first, then by path so equal mtimes never flip.
  return (
    candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))[0]?.path ?? null
  );
}

/** `<timestamp>_<sessionId>.jsonl` exactly — a substring test would match a
 * `…_<sessionId>-branch2.jsonl` sibling and ship another session's transcript. */
function matchesSession(name: string, sessionId: string): boolean {
  return name.endsWith(`_${sessionId}.jsonl`) || name === `${sessionId}.jsonl`;
}

function collectJsonl(
  dir: string,
  sessionId: string,
  out: { mtime: number; path: string }[],
  depth: number,
  budget: { scanned: number },
): void {
  if (depth > 3 || budget.scanned >= MAX_SCAN_ENTRIES) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.scanned >= MAX_SCAN_ENTRIES) {
      return;
    }
    budget.scanned += 1;
    // Dirent (lstat semantics) rather than statSync: a symlink in the sessions
    // root must not send the scan walking an arbitrary tree.
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonl(full, sessionId, out, depth + 1, budget);
    } else if (entry.isFile() && matchesSession(entry.name, sessionId)) {
      try {
        out.push({ mtime: statSync(full).mtimeMs, path: full });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
}

/** How much of the tail to read. A turn's last assistant message lives well
 * inside this; reading the whole file would put a multi-MB read + parse on the
 * hot path (measured: ~88 ms for a 10 MB session). */
const TAIL_BYTES = 256 * 1024;

/**
 * Last usage recorded in a session JSONL, for turns where the extension could not
 * forward it. Reads the file's TAIL only — never the whole file.
 *
 * CAUTION: two inferences here, neither verified against a real sample. The
 * per-entry nesting (`entry.message.usage`) comes from the documented session
 * format; and taking the LAST usage-bearing record as "this turn's usage" assumes
 * the agent has flushed the just-finished turn. If it has not, this can re-report
 * the previous turn's tokens. Forwarded usage from the extension is always
 * preferred; this is the fallback. Unrecognized shapes yield null — a Stop with
 * no `llm` block, never a wrong number.
 */
export function usageFromSessionFile(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) {
      return null;
    }
    const buf = Buffer.allocUnsafe(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      closeSync(fd);
    }
    text = buf.toString('utf8');
    if (start > 0) {
      // The first line is almost certainly cut mid-record; drop it.
      text = text.slice(text.indexOf('\n') + 1);
    }
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
      const model = pickValue(message, MODEL_KEYS) ?? pickValue(record, MODEL_KEYS);
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
      if (isPlainRecord(parsed)) {
        return parsed;
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
    const value = pickValue(raw, SESSION_ID_KEYS);
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const explicitTranscript = (raw: Record<string, unknown>): string | null => {
    const value = pickValue(raw, TRANSCRIPT_KEYS);
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const mapPayload = (kind: string, raw: Record<string, unknown>): ConformantEvent => {
    const eventType = PI_FAMILY_EVENT_TYPE[kind] ?? 'Notification';
    const isToolEvent = eventType === 'PreToolUse' || eventType === 'PostToolUse';

    const knownKeys = isToolEvent
      ? TOOL_KNOWN_KEYS
      : eventType === 'Stop'
        ? STOP_KNOWN_KEYS
        : OTHER_KNOWN_KEYS;
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!knownKeys.has(key)) {
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
        cwd: str(pickValue(raw, CWD_KEYS), process.cwd()),
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
      // No session id means the marker would be keyed to the nil UUID, colliding
      // with every other unknown-session transcript. Ship nothing instead.
      if (!native) {
        return null;
      }
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

export type ExtensionSnippetConfig = {
  /** `--agent` value the spawned hook is given. */
  agentArg: string;
  bin: string;
  /** Lines appended after the module (omp documents an alternative install). */
  footer?: string[];
  /** The `// path/to/file.ts` line that opens the snippet. */
  header: string;
  /** The object the extension factory receives, by the agent's own name. */
  paramName: string;
  /** Expression yielding the session id from the handler's `(event, ctx)`. */
  sessionFileExpr: string;
  sessionIdExpr: string;
};

/**
 * The extension module both agents install. Pi and omp subscribe through the same
 * `on(event, handler)` shape, so the module is one template with a handful of
 * substitutions rather than two ~30-line string literals kept in step by hand.
 *
 * It is deliberately observe-only: `tool_call` can BLOCK in both agents' APIs and
 * `tool_result` can rewrite a result, so the handler returns nothing and swallows
 * its own errors. Telemetry must never change what the agent does.
 */
export function renderExtensionSnippet(config: ExtensionSnippetConfig): string {
  const kinds = Object.entries(PI_FAMILY_NATIVE_EVENTS)
    .map(([native, kind]) => `  ${native}: '${kind}',`)
    .join('\n');
  return [
    config.header,
    'import { spawn } from "node:child_process";',
    '',
    'const KINDS: Record<string, string> = {',
    kinds,
    '};',
    '',
    `export default function (${config.paramName}: any) {`,
    '  for (const [native, kind] of Object.entries(KINDS)) {',
    `    ${config.paramName}.on(native, async (event: any, ctx: any) => {`,
    '      try {',
    '        const payload = {',
    '          ...event,',
    '          cwd: ctx?.cwd ?? process.cwd(),',
    `          sessionId: ${config.sessionIdExpr},`,
    `          sessionFile: ${config.sessionFileExpr},`,
    '        };',
    `        const p = spawn(${JSON.stringify(config.bin)}, ['hook', kind, '--agent', '${config.agentArg}'], {`,
    "          stdio: ['pipe', 'ignore', 'ignore'],",
    '          detached: true,',
    '        });',
    '        p.stdin.end(JSON.stringify(payload));',
    '        p.unref();',
    '      } catch {',
    '        // Telemetry must never break the agent: swallow and continue.',
    '      }',
    '      // Observe only: this handler never blocks a tool call and never',
    '      // rewrites a result, even though the API allows both.',
    '    });',
    '  }',
    '}',
    ...(config.footer ?? []),
  ].join('\n');
}
