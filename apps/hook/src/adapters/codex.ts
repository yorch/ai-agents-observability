import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Event, EventType, ToolInfo } from '@ai-agents-observability/schemas';

import { clientInfo } from '../lib/client-info';
import { type CodexUsage, parseRolloutRecords, usageDelta } from '../lib/codex-rollout';
import { userIdClaim } from '../lib/identity';
import { telemetryHome } from '../lib/paths';
import { uuidv7 } from '../lib/uuid';
import type { AdapterInstallConfig, ConformantEvent, HookAdapter, TranscriptTarget } from './index';

// OpenAI Codex CLI adapter (P8-007) — the THIRD HookAdapter, and the first to
// exercise the seam's multi-event path (`mapBatch`). Codex's only stable
// extension point is its `notify` program, which fires once per turn
// (agent-turn-complete) and carries no per-tool or token data. The rich record
// lives in the per-session rollout JSONL under `~/.codex/sessions`. So a single
// `notify` invocation legitimately yields MANY canonical events — the turn's tool
// calls plus a usage-bearing Stop — which `mapBatch` reads out of the rollout
// since a per-session byte cursor (no re-emitting prior turns).
//
// Lifecycle mapping (codex kind → canonical EventType):
//   session-start       → SessionStart
//   user-prompt-submit  → UserPromptSubmit
//   turn-complete       → Stop          (codex `notify`: agent-turn-complete)
//   session-end         → SessionEnd
// The shipped install snippet wires only `turn-complete` (the one event `notify`
// emits today); the rest are recognized so a richer future Codex signal can feed
// them without an interface change.

const CODEX_EVENT_TYPE: Record<string, EventType> = {
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
  'turn-complete': 'Stop',
  'user-prompt-submit': 'UserPromptSubmit',
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
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
    agent_type: 'codex',
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

function codexSessionsDir(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(home, 'sessions');
}

// Recursively collect rollout files (newer Codex nests them under YYYY/MM/DD/),
// newest first. Bounded depth; never throws.
function listRollouts(dir: string, depth = 0): string[] {
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
      for (const p of listRollouts(full, depth + 1)) {
        try {
          out.push({ mtime: statSync(p).mtimeMs, path: p });
        } catch {
          // ignore
        }
      }
    } else if (ROLLOUT_RE.test(name)) {
      out.push({ mtime: st.mtimeMs, path: full });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.path);
}

function sessionIdFromPath(path: string): string | null {
  return path.match(UUID_RE)?.[0] ?? null;
}

type RolloutLocation = { path: string; sessionId: string; cwd: string };

// Find the rollout file for this notify event: an explicit path on the payload if
// Codex provides one, else the file whose name contains the payload's session id,
// else the most recently modified rollout. Returns null when none is found.
function locateRollout(raw: Record<string, unknown>): RolloutLocation | null {
  const cwd = str(raw.cwd ?? raw['working-directory'] ?? raw.directory, process.cwd());

  const explicit = firstStr(raw, [
    'rollout-path',
    'rollout_path',
    'session-file',
    'session_file',
    'path',
  ]);
  if (explicit && existsSync(explicit)) {
    return { cwd, path: explicit, sessionId: sessionIdFromPath(explicit) ?? NIL_UUID };
  }

  const files = listRollouts(codexSessionsDir());
  const newest = files[0];
  if (newest === undefined) {
    return null;
  }

  const id = firstStr(raw, [
    'session-id',
    'session_id',
    'sessionId',
    'conversation-id',
    'conversation_id',
    'thread-id',
    'thread_id',
    'turn-id',
    'turn_id',
  ]);
  const path = (id ? files.find((f) => f.includes(id)) : undefined) ?? newest;
  return { cwd, path, sessionId: sessionIdFromPath(path) ?? id ?? NIL_UUID };
}

// ── Cursor (per-session byte offset + last cumulative usage) ────────────────────

type Cursor = { offset: number; usage: CodexUsage | null };

function cursorPath(sessionId: string): string {
  return join(telemetryHome(), 'codex-cursors', `${sessionId}.json`);
}

function readCursor(sessionId: string): Cursor {
  try {
    const fd = openSync(cursorPath(sessionId), 'r');
    try {
      const size = statSync(cursorPath(sessionId)).size;
      const buf = Buffer.allocUnsafe(size);
      readSync(fd, buf, 0, size, 0);
      const parsed = JSON.parse(buf.toString('utf8'));
      if (parsed && typeof parsed.offset === 'number') {
        return { offset: parsed.offset, usage: parsed.usage ?? null };
      }
    } finally {
      closeSync(fd);
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

function mapPayload(kind: string, raw: Record<string, unknown>): ConformantEvent {
  const eventType = CODEX_EVENT_TYPE[kind] ?? 'Notification';
  const sessionId =
    firstStr(raw, ['session-id', 'session_id', 'sessionId', 'turn-id', 'turn_id']) ?? NIL_UUID;
  const cwd = str(raw.cwd ?? raw['working-directory'] ?? raw.directory, process.cwd());
  return assemble(eventType, sessionId, cwd);
}

// Multi-event path: on turn-complete, read the rollout records appended since the
// last turn and emit a PostToolUse per tool call plus a usage-bearing Stop. Any
// failure returns null so the transport falls back to the single-event mapPayload
// (a bare Stop) — a broken rollout never blocks the turn signal.
function mapBatch(kind: string, raw: Record<string, unknown>): ConformantEvent[] | null {
  if (CODEX_EVENT_TYPE[kind] !== 'Stop') {
    return null;
  }
  try {
    const loc = locateRollout(raw);
    if (!loc) {
      return null;
    }
    const cursor = readCursor(loc.sessionId);
    const { lines, newOffset } = readNewLines(loc.path, cursor.offset);
    const records = lines.map(safeJson).filter((r): r is Record<string, unknown> => r !== null);
    const { toolCalls, cumulativeUsage } = parseRolloutRecords(records);

    const events: ConformantEvent[] = toolCalls.map((c) =>
      assemble('PostToolUse', loc.sessionId, loc.cwd, { tool: toolInfo(c) }),
    );
    const delta = usageDelta(cursor.usage, cumulativeUsage);
    events.push(
      assemble(
        'Stop',
        loc.sessionId,
        loc.cwd,
        hasUsage(delta) ? { llm: llmBlock(delta) } : undefined,
      ),
    );

    writeCursor(loc.sessionId, { offset: newOffset, usage: cumulativeUsage ?? cursor.usage });
    return events;
  } catch {
    return null;
  }
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
  ].join('\n');
}

export const codexAdapter: HookAdapter = {
  agentType: 'codex',

  installConfig(): AdapterInstallConfig {
    return {
      agentName: 'Codex CLI',
      hookKinds: Object.keys(CODEX_EVENT_TYPE),
      renderSnippet,
      settingsHint: 'Wire Codex `notify` to the telemetry binary:',
    };
  },

  isHookKind(value: string): boolean {
    return value in CODEX_EVENT_TYPE;
  },

  mapBatch,

  mapPayload,

  // Ship the rollout JSONL as the transcript. Codex emits no session-end signal,
  // so this fires every turn-complete and the (growing) rollout is re-uploaded
  // under the same session id — ingest keeps the latest, converging on the full
  // conversation. The per-tool events above carry the structured counts.
  transcriptTarget(kind: string, raw: Record<string, unknown>): TranscriptTarget | null {
    if (CODEX_EVENT_TYPE[kind] !== 'Stop') {
      return null;
    }
    const loc = locateRollout(raw);
    return loc ? { sessionId: loc.sessionId, transcriptPath: loc.path } : null;
  },
};
