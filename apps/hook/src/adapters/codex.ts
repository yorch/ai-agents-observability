import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  classifyNotification,
  type Event,
  type EventType,
  type ToolInfo,
} from '@ai-agents-observability/schemas';

import { clientInfo } from '../lib/client-info';
import { type CodexUsage, parseRolloutRecords, usageDelta } from '../lib/codex-rollout';
import { userIdClaim } from '../lib/identity';
import { telemetryHome } from '../lib/paths';
import { sessionUuid } from '../lib/session-id';
import { uuidv7 } from '../lib/uuid';
import type { AdapterInstallConfig, ConformantEvent, HookAdapter, TranscriptTarget } from './index';
import { createStdinHookAdapter } from './stdin-hook-factory';

// OpenAI Codex CLI adapter — TWO capture paths, because Codex has two extension
// points and the good one is still experimental.
//
// 1. NATIVE LIFECYCLE HOOKS (preferred, P12-004). Codex now ships Claude-shaped
//    stdin hooks — SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop,
//    SubagentStop, PreCompact, PermissionRequest, SessionEnd — carrying
//    `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`,
//    and the usual `tool_name` / `tool_input` / `tool_response`. That is the
//    stdin-hook factory's shape exactly, so per-tool capture is configuration.
//    They are gated behind `[features] hooks = true` in config.toml and are not
//    available on Windows, so they cannot be the only path.
//
// 2. `notify` (fallback, P8-007). Codex's long-stable extension point: one
//    invocation per turn, with no per-tool or token data. The rich record lives in
//    the per-session rollout JSONL under `~/.codex/sessions`, so one `notify` call
//    legitimately expands into MANY events — the turn's tool calls plus a
//    usage-bearing Stop — via the seam's `mapBatch`, behind a per-session byte
//    cursor so prior turns are never re-emitted.
//
// The rollout read survives the upgrade for ONE reason: the hook payload carries
// `model` but no token usage. So on the hooks path the rollout is read only for
// usage on Stop, not to infer tool calls.
//
// Lifecycle mapping (codex kind → canonical EventType):
//   session-start       → SessionStart      (hook + notify)
//   user-prompt-submit  → UserPromptSubmit  (hook + notify)
//   pre-tool-use        → PreToolUse        (hook only)
//   post-tool-use       → PostToolUse       (hook only)
//   permission-request  → Notification      (hook only)
//   pre-compact         → PreCompact        (hook only)
//   subagent-stop       → SubagentStop      (hook only)
//   stop                → Stop              (hook)
//   turn-complete       → Stop              (notify: agent-turn-complete)
//   session-end         → SessionEnd        (hook + notify)
// Codex's PostCompact and SubagentStart have no canonical equivalent and are not
// registered — we never synthesize a non-schema event_type.

const CODEX_EVENT_TYPE: Record<string, EventType> = {
  'permission-request': 'Notification',
  'post-tool-use': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
  stop: 'Stop',
  'subagent-stop': 'SubagentStop',
  'turn-complete': 'Stop',
  'user-prompt-submit': 'UserPromptSubmit',
};

/** The kind Codex's `notify` program feeds us — the only non-hook entry point. */
const NOTIFY_KIND = 'turn-complete';

// Payload keys captured structurally by the hook path. `model` and `turn_id` are
// deliberately absent so they flow into metadata: `turn_id` is the only
// turn-scoped correlator Codex gives us, and `model` is worth keeping even on
// events with no usage to price.
const CODEX_KNOWN_KEYS = [
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

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function firstStr(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return null;
}

// ── Event assembly ────────────────────────────────────────────────────────────

function assemble(
  eventType: EventType,
  sessionId: string,
  cwd: string,
  extra?: Partial<Event>,
): ConformantEvent {
  return {
    agent_type: 'CODEX',
    client: clientInfo(),
    event_id: uuidv7(),
    event_type: eventType,
    metadata: {},
    redaction_flags: [],
    schema_version: 1,
    session_context: { cwd, git: null, is_resume: false, mode: 'normal' },
    session_id: sessionId,
    ts: new Date().toISOString(),
    user_id_claim: userIdClaim(),
    ...extra,
  } as ConformantEvent;
}

function toolInfo(call: {
  name: string;
  inputBytes: number;
  outputBytes: number;
  wasDenied: boolean;
}): ToolInfo {
  const isMcp = call.name.startsWith('mcp__');
  return {
    category: isMcp ? 'mcp' : 'builtin',
    duration_ms: 0,
    exit_status: null,
    input_bytes: call.inputBytes,
    input_hash: null,
    mcp_server: null,
    mcp_tool: null,
    name: call.name,
    output_bytes: call.outputBytes,
    skill: null,
    slash_command: null,
    subagent_type: null,
    was_denied: call.wasDenied,
    was_interrupted: false,
  };
}

function llmBlock(usage: CodexUsage): NonNullable<Event['llm']> {
  return {
    cache_creation_tokens: usage.cacheWriteTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cost_usd: 0, // computed ingest-side from the codex price table (empty for now)
    input_tokens: usage.inputTokens,
    model: usage.model ?? 'unknown',
    output_tokens: usage.outputTokens,
  };
}

function hasUsage(usage: CodexUsage | null): usage is CodexUsage {
  return (
    usage !== null && (usage.model !== null || usage.inputTokens > 0 || usage.outputTokens > 0)
  );
}

// ── Rollout location ──────────────────────────────────────────────────────────

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function codexSessionsDir(): string {
  return join(codexHome(), 'sessions');
}

// ── Which capture path is live ────────────────────────────────────────────────

// Are Codex's native lifecycle hooks configured? Two signals, either sufficient:
// a `hooks.json` in CODEX_HOME, or the feature flag in config.toml. Codex accepts
// both `hooks` (canonical) and the deprecated `codex_hooks` alias, commented lines
// don't count, and the flag can be `true` or `"true"`.
//
// Memoized: the notify path checks this on every turn, and one small read per
// process is enough. Never throws — an unreadable config means "hooks off", which
// keeps the fallback path working rather than losing the turn.
let hooksEnabledMemo: boolean | null = null;

export function codexHooksEnabled(): boolean {
  if (hooksEnabledMemo !== null) {
    return hooksEnabledMemo;
  }
  hooksEnabledMemo = detectHooksEnabled();
  return hooksEnabledMemo;
}

/** Test seam: forget the memoized answer. */
export function resetCodexHooksCache(): void {
  hooksEnabledMemo = null;
}

function detectHooksEnabled(): boolean {
  const home = codexHome();
  if (existsSync(join(home, 'hooks.json'))) {
    return true;
  }
  try {
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    return config
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#'))
      .some((line) => /^(codex_)?hooks\s*=\s*"?true"?$/.test(line));
  } catch {
    return false;
  }
}

// Recursively collect rollout files (newer Codex nests them under YYYY/MM/DD/),
// newest first. Bounded depth; never throws. Each file is stat'd exactly once —
// the recursive call carries mtime up rather than the parent re-statting.
function collectRollouts(dir: string, depth = 0): { path: string; mtime: number }[] {
  if (depth > 5 || !existsSync(dir)) {
    return [];
  }
  const out: { path: string; mtime: number }[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
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
      out.push(...collectRollouts(full, depth + 1));
    } else if (ROLLOUT_RE.test(name)) {
      out.push({ mtime: st.mtimeMs, path: full });
    }
  }
  return out;
}

function listRollouts(dir: string): string[] {
  return collectRollouts(dir)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.path);
}

function sessionIdFromPath(path: string): string | null {
  return path.match(UUID_RE)?.[0] ?? null;
}

// Session/conversation id and working dir, read from a Codex notify payload under
// any of the field spellings Codex has used. Shared by mapPayload (fallback Stop)
// and locateRollout so the two never drift on which keys they accept.
const SESSION_ID_KEYS = [
  'session-id',
  'session_id',
  'sessionId',
  'conversation-id',
  'conversation_id',
  'thread-id',
  'thread_id',
  'turn-id',
  'turn_id',
];

function sessionIdFromPayload(raw: Record<string, unknown>): string | null {
  return firstStr(raw, SESSION_ID_KEYS);
}

function cwdFromPayload(raw: Record<string, unknown>): string {
  return str(raw.cwd ?? raw['working-directory'] ?? raw.directory, process.cwd());
}

type RolloutLocation = { path: string; sessionId: string; cwd: string };

// One hook invocation (one process) calls locateRollout twice — mapBatch and
// transcriptTarget both need it — and each call is a full recursive directory
// walk + stat of ~/.codex/sessions. Memoize on the payload object so the walk
// runs once per invocation. (The cache is keyed by reference and the process is
// short-lived, so it never grows.)
const locationMemo = new WeakMap<object, RolloutLocation | null>();

function locateRollout(raw: Record<string, unknown>): RolloutLocation | null {
  if (locationMemo.has(raw)) {
    return locationMemo.get(raw) ?? null;
  }
  const result = locateRolloutUncached(raw);
  locationMemo.set(raw, result);
  return result;
}

// Find the rollout file for this notify event: an explicit path on the payload if
// Codex provides one, else the file whose name contains the payload's session id,
// else the most recently modified rollout. Returns null when none is found.
function locateRolloutUncached(raw: Record<string, unknown>): RolloutLocation | null {
  const cwd = cwdFromPayload(raw);

  const explicit = firstStr(raw, [
    'rollout-path',
    'rollout_path',
    'session-file',
    'session_file',
    'path',
  ]);
  if (explicit && existsSync(explicit)) {
    return { cwd, path: explicit, sessionId: sessionUuid('CODEX', sessionIdFromPath(explicit)) };
  }

  const files = listRollouts(codexSessionsDir());
  const newest = files[0];
  if (newest === undefined) {
    return null;
  }

  const id = sessionIdFromPayload(raw);
  const path = (id ? files.find((f) => f.includes(id)) : undefined) ?? newest;
  // The rollout filename carries a UUID (pass-through); the payload fallback may
  // not, so both go through normalization (P12-002).
  return { cwd, path, sessionId: sessionUuid('CODEX', sessionIdFromPath(path) ?? id) };
}

// ── Cursor (per-session byte offset + last cumulative usage) ────────────────────

type Cursor = { offset: number; usage: CodexUsage | null };

function cursorPath(sessionId: string): string {
  return join(telemetryHome(), 'codex-cursors', `${sessionId}.json`);
}

function readCursor(sessionId: string): Cursor {
  try {
    // Small JSON file — one read beats open + stat + readSync + close.
    const parsed = JSON.parse(readFileSync(cursorPath(sessionId), 'utf8'));
    if (parsed && typeof parsed.offset === 'number') {
      return { offset: parsed.offset, usage: parsed.usage ?? null };
    }
  } catch {
    // no cursor yet
  }
  return { offset: 0, usage: null };
}

function writeCursor(sessionId: string, cursor: Cursor): void {
  const p = cursorPath(sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cursor), { encoding: 'utf8', mode: 0o600 });
}

// Read only the bytes appended since the stored offset, returning whole lines and
// the new offset (up to the last newline so a half-written final line waits for
// the next turn).
function readNewLines(path: string, fromOffset: number): { lines: string[]; newOffset: number } {
  const size = statSync(path).size;
  if (size <= fromOffset) {
    return { lines: [], newOffset: fromOffset };
  }
  const len = size - fromOffset;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromOffset);
  } finally {
    closeSync(fd);
  }
  const slice = buf.toString('utf8');
  const lastNl = slice.lastIndexOf('\n');
  if (lastNl < 0) {
    return { lines: [], newOffset: fromOffset };
  }
  const consumed = slice.slice(0, lastNl + 1);
  const lines = consumed.split('\n').filter((l) => l.trim().length > 0);
  return { lines, newOffset: fromOffset + Buffer.byteLength(consumed, 'utf8') };
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ── Adapter ─────────────────────────────────────────────────────────────────

// The native-hooks path. Codex's payload is Claude-shaped, so this is pure
// configuration — no Codex-specific mapping code beyond the event names.
const hookAdapter = createStdinHookAdapter({
  agentType: 'CODEX',
  enrich: (event, _kind, raw) => {
    // PermissionRequest lands as a Notification; classify it the same way Claude's
    // permission prompts are, so `notification_kind` aggregates across agents.
    if (event.event_type === 'Notification') {
      event.metadata.notification_kind = classifyNotification('permission_request', raw.message);
    }
  },
  eventMap: CODEX_EVENT_TYPE,
  install: {
    agentName: 'Codex CLI',
    renderSnippet: (bin) => renderSnippet(bin),
    settingsHint: '',
  },
  knownKeys: CODEX_KNOWN_KEYS,
  // Codex hands us the transcript path directly on every hook — no directory scan.
  transcriptKinds: ['stop', 'session-end'],
});

function mapPayload(kind: string, raw: Record<string, unknown>): ConformantEvent {
  if (kind !== NOTIFY_KIND) {
    return hookAdapter.mapPayload(kind, raw);
  }
  // `notify` payloads spell the session id half a dozen ways and carry no
  // hook_event_name, so they get the hand-rolled reader rather than the factory.
  const eventType = CODEX_EVENT_TYPE[kind] ?? 'Notification';
  const sessionId = sessionUuid('CODEX', sessionIdFromPayload(raw));
  return assemble(eventType, sessionId, cwdFromPayload(raw));
}

/** Rollout usage consumed since the last read, advancing the session's cursor. */
function readUsageDelta(loc: RolloutLocation): {
  delta: CodexUsage | null;
  toolCalls: ReturnType<typeof parseRolloutRecords>['toolCalls'];
} {
  const cursor = readCursor(loc.sessionId);
  const { lines, newOffset } = readNewLines(loc.path, cursor.offset);
  const records = lines.map(safeJson).filter((r): r is Record<string, unknown> => r !== null);
  const { toolCalls, cumulativeUsage } = parseRolloutRecords(records);
  writeCursor(loc.sessionId, { offset: newOffset, usage: cumulativeUsage ?? cursor.usage });
  // `token_count` in the rollout is a running total, so it is diffed to a per-turn
  // delta — never summed.
  return { delta: usageDelta(cursor.usage, cumulativeUsage), toolCalls };
}

// Multi-event path. Two shapes, one per capture path:
//
//   stop (hook)      → exactly one Stop, with usage read from the rollout. Tool
//                      calls already arrived as their own PreToolUse/PostToolUse
//                      hooks, so expanding them here would double-count.
//   turn-complete    → the P8-007 expansion: a PostToolUse per tool call in the
//   (notify)           turn plus a usage-bearing Stop, all inferred from the
//                      rollout, because `notify` carries none of it.
//
// Any failure returns null so the transport falls back to the single-event
// mapPayload (a bare Stop) — a broken rollout never blocks the turn signal.
function mapBatch(kind: string, raw: Record<string, unknown>): ConformantEvent[] | null {
  if (kind === 'stop') {
    return stopWithUsage(raw);
  }
  if (kind !== NOTIFY_KIND) {
    return null;
  }
  // Both paths wired at once would emit two Stops per turn. The hooks path is
  // strictly richer, so notify stands down when hooks are configured.
  if (codexHooksEnabled()) {
    return [];
  }
  try {
    const loc = locateRollout(raw);
    if (!loc) {
      return null;
    }
    const { delta, toolCalls } = readUsageDelta(loc);

    const events: ConformantEvent[] = toolCalls.map((c) =>
      assemble('PostToolUse', loc.sessionId, loc.cwd, { tool: toolInfo(c) }),
    );
    events.push(
      assemble(
        'Stop',
        loc.sessionId,
        loc.cwd,
        hasUsage(delta) ? { llm: llmBlock(delta) } : undefined,
      ),
    );
    return events;
  } catch {
    return null;
  }
}

// The hooks path's one piece of real logic: Codex's Stop hook carries `model` but
// no token usage, so the usage is read from the rollout and attached to the event
// the factory built. Returning null falls back to a usage-less Stop.
function stopWithUsage(raw: Record<string, unknown>): ConformantEvent[] | null {
  try {
    const event = hookAdapter.mapPayload('stop', raw);
    const loc = rolloutForHook(raw, event.session_id);
    if (!loc) {
      return null;
    }
    const { delta } = readUsageDelta(loc);
    if (!hasUsage(delta)) {
      return [event];
    }
    const model = str(raw.model, delta.model ?? 'unknown');
    return [{ ...event, llm: { ...llmBlock(delta), model } } as ConformantEvent];
  } catch {
    return null;
  }
}

// Where a hook event's rollout lives: `transcript_path` when Codex gives us one
// (it always should), else the same directory scan the notify path uses.
function rolloutForHook(
  raw: Record<string, unknown>,
  normalizedSessionId: string,
): RolloutLocation | null {
  const transcriptPath = raw.transcript_path;
  if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
    return {
      cwd: str(raw.cwd, process.cwd()),
      path: transcriptPath,
      sessionId: normalizedSessionId,
    };
  }
  return locateRollout(raw);
}

function renderSnippet(bin: string): string {
  const home = homedir();
  return [
    '# 1. Save this wrapper as ~/.codex/claude-telemetry-notify.sh and `chmod +x` it.',
    '#    Codex passes the notification JSON as the first argument:',
    '#!/bin/sh',
    `printf '%s' "$1" | ${bin} hook turn-complete --agent codex`,
    '',
    '# 2. Point Codex at the wrapper in ~/.codex/config.toml:',
    `notify = ["${home}/.codex/claude-telemetry-notify.sh"]`,
    '',
    '# Richer capture (per-tool events) is available via Codex lifecycle hooks.',
    '# They are experimental and off by default; enable them in config.toml with',
    '#   [features]',
    '#   hooks = true',
    '# then re-run `claude-telemetry install --agent codex` for the hooks snippet.',
    '# (Not available on Windows.)',
  ].join('\n');
}

// The hooks snippet: one command hook per Codex lifecycle event, in the
// `hooks.json` form. Codex merges hooks.json with inline [hooks] in config.toml
// and warns at startup, so we write exactly one of them.
const HOOK_KIND_TO_CODEX_EVENT: Record<string, string> = {
  'permission-request': 'PermissionRequest',
  'post-tool-use': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
  stop: 'Stop',
  'subagent-stop': 'SubagentStop',
  'user-prompt-submit': 'UserPromptSubmit',
};

function renderHooksSnippet(bin: string): string {
  const hooks: Record<string, { command: string[]; type: string }[]> = {};
  for (const [kind, codexEvent] of Object.entries(HOOK_KIND_TO_CODEX_EVENT)) {
    // Exec form (argv array), so a binary path containing spaces is not
    // word-split and no shell metacharacter surface exists.
    hooks[codexEvent] = [{ command: [bin, 'hook', kind, '--agent', 'codex'], type: 'command' }];
  }
  return JSON.stringify({ hooks }, null, 2);
}

export const codexAdapter: HookAdapter = {
  agentType: 'CODEX',

  installConfig(): AdapterInstallConfig {
    const hooksOn = codexHooksEnabled();
    return {
      agentName: 'Codex CLI',
      hookKinds: Object.keys(CODEX_EVENT_TYPE),
      renderSnippet: hooksOn ? renderHooksSnippet : renderSnippet,
      settingsHint: hooksOn
        ? 'Codex lifecycle hooks are enabled ([features] hooks = true). Write this to ~/.codex/hooks.json:'
        : 'Wire Codex `notify` to the telemetry binary:',
    };
  },

  isHookKind(value: string): boolean {
    return value in CODEX_EVENT_TYPE;
  },

  mapBatch,

  mapPayload,

  transcriptTarget(kind: string, raw: Record<string, unknown>): TranscriptTarget | null {
    if (CODEX_EVENT_TYPE[kind] !== 'Stop' && CODEX_EVENT_TYPE[kind] !== 'SessionEnd') {
      return null;
    }
    // Hooks path: Codex hands us `transcript_path` directly.
    if (kind !== NOTIFY_KIND) {
      const target = hookAdapter.transcriptTarget(kind, raw);
      if (target) {
        return target;
      }
    }
    // notify path: find the rollout JSONL ourselves. Codex emits no session-end
    // signal there, so this fires every turn-complete and the (growing) rollout is
    // re-uploaded under the same session id — ingest keeps the latest, converging
    // on the full conversation.
    const loc = locateRollout(raw);
    return loc ? { sessionId: loc.sessionId, transcriptPath: loc.path } : null;
  },
};
