import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Event } from '@ai-agents-observability/schemas';

import { assistantTurn, isAssistantEntry, toolUseIdsMetadata } from '../lib/claude-turns';
import {
  createBackupIfAbsent,
  dirExists,
  homeDir,
  readJsonFile,
  removeBackup,
  stripOwnedEntries,
  writeJsonFile,
} from '../lib/config-wire';
import { deferCommit } from '../lib/deferred-commit';
import { log } from '../lib/log';
import { agentStateDir } from '../lib/paths';
import {
  buildClaudeToolInfo,
  CLAUDE_KNOWN_KEYS,
  type ClaudeCodeHookPayload,
  enrichClaudeMetadata,
  HOOK_KIND_TO_EVENT_TYPE,
  type HookKind,
} from '../lib/payload';
import { NIL_UUID } from '../lib/session-id';
import { readLinesWindow, readNewLines, safeJsonLine } from '../lib/tail-read';
import type { ConformantEvent, HookAdapter, RemoveOutcome, TailChunk } from './index';
import { createStdinHookAdapter } from './stdin-hook-factory';

// Claude Code adapter — the first HookAdapter implementation, and (since P12-003)
// the first caller of the stdin-hook factory. The Claude-specific pieces live in
// lib/payload.ts; everything here is configuration — plus the per-turn usage read
// below (P14-003).

const HOOK_KINDS = Object.keys(HOOK_KIND_TO_EVENT_TYPE) as HookKind[];

// Maps CLI arg kind (kebab-case) to the PascalCase event name Claude Code
// expects as a key in ~/.claude/settings.json. Identical to the canonical
// EventType for every kind today — but written out as its own literal, NOT
// aliased to HOOK_KIND_TO_EVENT_TYPE. They are two different namespaces that
// happen to agree: remapping a kind's canonical EventType (say `stop` →
// SessionEnd) must not silently rewrite the settings key we ask Claude Code to
// register, which would stop the hook firing at all.
const HOOK_KIND_TO_SETTINGS_KEY: Record<HookKind, string> = {
  notification: 'Notification',
  'post-tool-use': 'PostToolUse',
  'pre-compact': 'PreCompact',
  'pre-tool-use': 'PreToolUse',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
  stop: 'Stop',
  'subagent-stop': 'SubagentStop',
  'user-prompt-submit': 'UserPromptSubmit',
};

// Exec form (command + args array) so Claude Code spawns the binary directly
// rather than routing through `sh -c`. This avoids shell word-splitting on
// binary paths that contain spaces, and eliminates any metacharacter injection
// surface regardless of the install location.
type HookEntry = { args: string[]; command: string; type: string };
type HookGroup = { hooks: HookEntry[] };

function renderSnippet(bin: string): string {
  const hooks: Record<string, HookGroup[]> = {};
  for (const kind of HOOK_KINDS) {
    hooks[HOOK_KIND_TO_SETTINGS_KEY[kind]] = [
      { hooks: [{ args: ['hook', kind], command: bin, type: 'command' }] },
    ];
  }
  return JSON.stringify({ hooks }, null, 2);
}

// ── Per-turn usage (P14-003) ──────────────────────────────────────────────────
//
// Claude Code's hook payload carries NO token usage — on any hook, including
// Stop. Until this existed, the only producer of an `llm` block for CLAUDE_CODE
// was the `import` subcommand, so a session captured live recorded $0 for its
// whole lifetime: no `llm` → NULL `events.cost_usd` → $0 `sessions.total_cost_usd`
// → $0 on every spend, run-rate and routing surface downstream.
//
// The usage is on disk the whole time: the Stop payload hands us
// `transcript_path`, and each `assistant` entry in that JSONL carries
// `message.usage`. This is the same side-channel trick Codex (rollout JSONL) and
// Gemini (per-call accumulator) already use, through the same `mapBatch` seam —
// Claude Code was simply the one adapter that never wired it up.
//
// TWO decisions here are load-bearing:
//
// 1. ONE Stop EVENT PER ASSISTANT TURN, not one per hook fire. Claude Code's Stop
//    hook fires once per user-prompt response cycle, which can span many assistant
//    turns; summing them into a single event would throw away the per-turn
//    granularity the whole point of this work is to capture.
//
// 2. THE EVENT ID AND ts COME FROM THE TRANSCRIPT ENTRY, via the shared
//    lib/claude-turns.ts, so they are IDENTICAL to what `import` synthesizes for
//    the same turn. That is what makes live capture and a later
//    `aiot import` of the same session safe: ingest dedupes on
//    `ON CONFLICT (event_id, ts) DO NOTHING`, so the second one is a no-op and
//    the cost is counted once. Without it the two paths mint different ids for
//    the same tokens and `sessions.total_cost_usd` — which accumulates and is
//    never recomputed — would drift permanently high.

/**
 * Per-session read cursor.
 *
 * `path` is part of it because an offset only means anything against the file it
 * was measured in; `turns` is the assistant-turn ordinal, carried across reads so
 * `turn_number` keeps counting from where the previous Stop left off.
 *
 * WHY HERE AND NOT THE SQLITE QUEUE. The queue (lib/queue.ts) is the transport's,
 * opened by `hook-entry` purely to append rows; adding a cursor table would put a
 * second statement inside the hot path's one write and give adapter state a home
 * outside `agentStateDir`. apps/hook/AGENTS.md is explicit that adapter working
 * state lives under `agentStateDir(<agent>)` so `purge-local` clears every agent's
 * state without naming any of them — that rule exists because per-session state
 * once survived a "delete all local telemetry data". Codex's rollout cursors and
 * Gemini's token accumulators are already there; this is the same kind of thing.
 */
type TurnCursor = { offset: number; path: string | null; turns: number };

/** Cursors for sessions untouched this long are swept. See {@link pruneStaleCursors}. */
const CURSOR_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function cursorDir(): string {
  return agentStateDir('claude-code');
}

function cursorPath(sessionId: string): string {
  return join(cursorDir(), `${sessionId}.json`);
}

/**
 * Read the cursor for a session, or a zeroed one when there is none.
 *
 * A cursor recorded against a DIFFERENT file resets BOTH fields, not just the
 * offset: `turns` is an ordinal within one transcript, so carrying it onto
 * another file would number the same turn differently from `import` and break the
 * id/ordinal agreement the whole design rests on. Re-reading a file from 0 is
 * cheap in consequence — the ids are deterministic, so the re-read turns dedupe.
 */
function readCursor(sessionId: string, forPath: string): { cursor: TurnCursor; existed: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(sessionId), 'utf8'));
    if (parsed && typeof parsed.offset === 'number' && parsed.path === forPath) {
      return {
        cursor: {
          offset: parsed.offset,
          path: forPath,
          turns: typeof parsed.turns === 'number' ? parsed.turns : 0,
        },
        existed: true,
      };
    }
  } catch {
    // no cursor yet, or an unreadable one — start from the top of the file
  }
  return { cursor: { offset: 0, path: forPath, turns: 0 }, existed: false };
}

function writeCursor(sessionId: string, cursor: TurnCursor): void {
  const p = cursorPath(sessionId);
  // 0o700/0o600 like every other per-session state dir: this holds session ids,
  // a local file path and token counts.
  mkdirSync(dirname(p), { mode: 0o700, recursive: true });
  writeFileSync(p, JSON.stringify(cursor), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Sweep cursors for sessions that have not been written to in {@link CURSOR_TTL_MS}.
 *
 * Nothing drops a session's cursor when the session ends: the SessionEnd hook is
 * registered but only emits an event and a ship marker, it does not clean up
 * adapter state (and a killed session never fires it) — without a sweep
 * the directory grows one small file per session forever. Called ONLY on the first
 * Stop of a session (when no cursor existed), so it is one readdir per session,
 * never per turn and never on the tool hot path. Best-effort throughout: a
 * cursor we fail to delete is clutter, not a failure worth surfacing.
 */
function pruneStaleCursors(): void {
  const dir = cursorDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // directory does not exist yet
  }
  const cutoff = Date.now() - CURSOR_TTL_MS;
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) {
        rmSync(p, { force: true });
      }
    } catch {
      // vanished between readdir and stat, or not ours to remove
    }
  }
}

/**
 * One assistant transcript entry as a Stop-typed turn event: deterministic id, the
 * `llm` block, `tool_use_ids`, and no transcript CONTENT (lib/claude-turns.ts).
 * Shared by the Stop read and the SessionEnd tail so a turn is the same row from
 * whichever hook mints it.
 */
function mintTurn(
  template: ConformantEvent,
  entry: Parameters<typeof assistantTurn>[0],
  turnNumber: number,
): ConformantEvent {
  const turn = assistantTurn(entry);
  return {
    ...template,
    event_id: turn.eventId,
    llm: turn.llm,
    // Marks the derivation, matching what `import` writes, so the row reads
    // the same whichever path inserted it first. No transcript CONTENT is
    // copied here — see lib/claude-turns.ts.
    //
    // `tool_use_ids` is the P14-006 half: the ids of the calls THIS turn
    // issued, read off lines this Stop was already parsing for usage. It is
    // the only new information the linkage needs, and it costs no extra I/O
    // — which is why the linkage is derived here and not on the tool hooks,
    // where reading a file is forbidden (apps/hook/AGENTS.md).
    metadata: {
      ...template.metadata,
      source: 'claude-jsonl',
      ...toolUseIdsMetadata(turn.toolUseIds),
    },
    ts: turn.ts,
    turn_number: turnNumber,
  } as ConformantEvent;
}

/**
 * The turns appended since the last Stop, as Stop events.
 *
 * Returns null — "no batch, fall back to the plain single Stop" — for every
 * degraded case: no transcript path, an unknown session, a missing/locked/
 * unreadable file, or nothing new to read. That is the always-exit-0 rule applied
 * to money: a transcript we cannot read costs the turn its usage, never the turn
 * itself, and never the host agent.
 *
 * The read is INCREMENTAL. Stop fires once per response cycle, so re-reading the
 * whole transcript each time is O(n²) over a session — on a long one that is
 * megabytes of parsing per Stop, well past the hook's budget. Reading from the
 * stored byte offset makes the whole session O(n). The FIRST Stop of a session
 * does read the file from the top, and that is deliberate rather than an
 * oversight: the turn ordinal has to be counted from entry one for it to agree
 * with what `import` computes for the same session (and for a `--resume`d session
 * to continue the earlier file's numbering).
 */
function stopWithUsage(raw: Record<string, unknown>): ConformantEvent[] | null {
  let template: ConformantEvent;
  try {
    template = base.mapPayload('stop', raw);
  } catch {
    return null;
  }
  try {
    const transcriptPath = raw.transcript_path;
    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
      return null;
    }
    // A nil session id means "unknown session": several of them would share one
    // cursor file and apply each other's offsets and ordinals.
    if (template.session_id === NIL_UUID) {
      return null;
    }

    const { cursor, existed } = readCursor(template.session_id, transcriptPath);
    if (!existed) {
      pruneStaleCursors();
    }
    const { lines, newOffset } = readNewLines(transcriptPath, cursor.offset);

    const events: ConformantEvent[] = [];
    let turns = cursor.turns;
    for (const line of lines) {
      const entry = safeJsonLine(line);
      // A malformed line costs its own turn's usage and nothing else — the ordinal
      // does not advance for a line we could not read as an assistant entry, which
      // keeps live and import numbering in step (import skips it identically).
      if (!isAssistantEntry(entry)) {
        continue;
      }
      turns += 1;
      events.push(mintTurn(template, entry, turns));
    }

    // Committed only once the events are QUEUED, not merely built. The old
    // comment here said "once the events exist", and that was the bug: existing
    // is not surviving. `hook-entry` calls this before it opens the queue and
    // before it enqueues, and both of those can fail (full disk, locked or
    // corrupt queue.db) and only log. The cursor was already past those lines,
    // so the next Stop read from the new offset and the turns were gone — along
    // with the `llm` block that is the only live source of Claude Code token
    // usage, leaving sessions.total_cost_usd permanently low and nothing to say
    // so. See lib/deferred-commit.ts.
    deferCommit('claude.cursor', () =>
      writeCursor(template.session_id, { offset: newOffset, path: transcriptPath, turns }),
    );
    // No new turns (a Stop with nothing appended since the last one) falls back to
    // the ordinary single Stop, so the session's end signal is never lost.
    return events.length > 0 ? events : null;
  } catch (err) {
    log('warn', 'claude.usage.read_failed', { message: (err as Error).message });
    return null;
  }
}

// ── Auto-wire: detect / apply / remove ────────────────────────────────────────

const CLAUDE_CONFIG_DIR = () => join(homeDir(), '.claude');
const CLAUDE_SETTINGS_PATH = () => join(CLAUDE_CONFIG_DIR(), 'settings.json');
// Ownership is structural (lib/config-wire.ts isOwnedHook), not a substring.

function detectClaudeCode(): boolean {
  return dirExists(CLAUDE_CONFIG_DIR());
}

function applyClaudeCode(bin: string): string | null {
  const settingsPath = CLAUDE_SETTINGS_PATH();
  try {
    const existing = readJsonFile<Record<string, unknown>>(settingsPath) ?? {};
    createBackupIfAbsent(settingsPath);

    // Build our hook entries (same shape as renderSnippet, but as an object).
    const ourHooks: Record<string, HookGroup[]> = {};
    for (const kind of HOOK_KINDS) {
      ourHooks[HOOK_KIND_TO_SETTINGS_KEY[kind]] = [
        { hooks: [{ args: ['hook', kind], command: bin, type: 'command' }] },
      ];
    }

    // Merge: for each event key, strip our old entries then append new ones.
    const userHooks = (existing.hooks as Record<string, unknown[]>) ?? {};
    const merged: Record<string, unknown[]> = {};
    for (const [event, entries] of Object.entries(userHooks)) {
      merged[event] = Array.isArray(entries) ? stripOwnedEntries(entries) : [];
    }
    for (const [event, entries] of Object.entries(ourHooks)) {
      merged[event] = [...(merged[event] ?? []), ...entries];
    }

    writeJsonFile(settingsPath, { ...existing, hooks: merged });
    return `merged into ${settingsPath}`;
  } catch (err) {
    process.stderr.write(`Error wiring Claude Code: ${(err as Error).message}\n`);
    return null;
  }
}

function removeClaudeCode(): RemoveOutcome {
  const settingsPath = CLAUDE_SETTINGS_PATH();
  try {
    const existing = readJsonFile<Record<string, unknown>>(settingsPath);
    if (!existing) {
      return 'unchanged';
    }
    const hooks = (existing.hooks as Record<string, unknown[]>) ?? {};
    const cleaned: Record<string, unknown[]> = {};
    let hadAny = false;
    for (const [event, entries] of Object.entries(hooks)) {
      const stripped = Array.isArray(entries) ? stripOwnedEntries(entries) : entries;
      if (Array.isArray(stripped)) {
        if (JSON.stringify(stripped) !== JSON.stringify(entries)) {
          hadAny = true;
        }
        if (stripped.length > 0) {
          cleaned[event] = stripped;
        }
      } else {
        cleaned[event] = stripped;
      }
    }
    if (!hadAny) {
      return 'unchanged';
    }
    writeJsonFile(settingsPath, { ...existing, hooks: cleaned });
    removeBackup(settingsPath);
    return 'removed';
  } catch (err) {
    process.stderr.write(`Error removing Claude Code hooks: ${(err as Error).message}\n`);
    return 'failed';
  }
}

const base = createStdinHookAdapter({
  agentType: 'CLAUDE_CODE',
  buildTool: (raw) => buildClaudeToolInfo(raw),
  enrich: (event, _kind, raw) => {
    enrichClaudeMetadata(event.metadata, event.event_type, raw);
  },
  eventMap: HOOK_KIND_TO_EVENT_TYPE,
  install: {
    agentName: 'Claude Code',
    apply: applyClaudeCode,
    detect: detectClaudeCode,
    remove: removeClaudeCode,
    renderSnippet,
    settingsHint: 'Add to ~/.claude/settings.json:',
  },
  knownKeys: CLAUDE_KNOWN_KEYS,
  // Claude Code ships the transcript at Stop, and again at SessionEnd — the one
  // hook that fires however the session ends (/exit, ctrl-D, /clear, logout),
  // where Stop never fires if the user quits mid-response. The path + session id
  // come from the hook payload (transcript_path / session_id), not a computed
  // location.
  transcriptKinds: ['stop', 'session-end'],
});

/**
 * A SessionEnd payload dressed as the Stop whose turns it mints. Everything is kept
 * except SessionEnd's own `reason`, and `stop_hook_active` (a Stop-only flag) defaults
 * to false so the metadata keys line up. `admitsToMetadata` still decides what reaches
 * metadata, as for a real Stop.
 *
 * What is NOT the same as a turn a Stop mints: Claude Code builds a SessionEnd payload
 * without the permission mode and effort a Stop carries, so `session_context.mode` of
 * these turns is the default rather than e.g. `accept_edits`, `metadata.effort` is
 * absent, and `stop_hook_active` is the default. Ingest keeps whichever row for an
 * (event_id, ts) arrives first, so a turn's mode follows the hook that reached it first.
 */
function stopShaped(raw: Record<string, unknown>): Record<string, unknown> {
  const { reason: _reason, ...rest } = raw;
  return { stop_hook_active: false, ...rest, hook_event_name: 'Stop' };
}

/** Bytes of transcript read per window at SessionEnd (a cold one can be 100 MB). */
const TAIL_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * The turns after the last Stop, for the SessionEnd hook (see `HookAdapter.tail`).
 *
 * Same cursor, same deterministic ids and same Stop-typed events as `stopWithUsage`,
 * so Stop-then-SessionEnd reads each turn once. Unlike Stop it is chunked and
 * time-boxed: each chunk's `commit` moves the cursor to the byte just past the last
 * line that chunk covered, with the turn ordinal at that point, so a kill, a full
 * queue or the deadline leave a cursor that is exact and the rest is read by the
 * next Stop, SessionEnd or import. An empty transcript tail commits nothing.
 */
function* sessionEndTail(
  raw: Record<string, unknown>,
  opts: { chunkSize: number; shouldStop(): boolean },
): Generator<TailChunk, void, void> {
  const transcriptPath = raw.transcript_path;
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return;
  }
  let template: ConformantEvent;
  try {
    template = base.mapPayload('stop', stopShaped(raw));
  } catch {
    return;
  }
  const sessionId = template.session_id;
  if (sessionId === NIL_UUID) {
    return;
  }
  const { cursor, existed } = readCursor(sessionId, transcriptPath);
  if (!existed) {
    pruneStaleCursors();
  }
  let offset = cursor.offset;
  let turns = cursor.turns;
  const commitAt = (at: number, ordinal: number) => () =>
    writeCursor(sessionId, { offset: at, path: transcriptPath, turns: ordinal });

  const startTurns = turns;
  let doneAt = offset; // the byte just past the last chunk handed out
  /** The time box ended the pass: say how much is left, so a silent cut-off is not invisible. */
  const stoppedAtDeadline = () => {
    let remaining = -1;
    try {
      remaining = statSync(transcriptPath).size - doneAt;
    } catch {
      // the log line is best effort
    }
    log('info', 'hook.tail.deadline', { queued: turns - startTurns, remaining_bytes: remaining });
  };

  while (!opts.shouldStop()) {
    let window: ReturnType<typeof readLinesWindow>;
    try {
      window = readLinesWindow(transcriptPath, offset, TAIL_WINDOW_BYTES);
    } catch (err) {
      // A missing or unreadable transcript costs the usage, never the hook.
      log('warn', 'claude.usage.read_failed', { message: (err as Error).message });
      return;
    }
    const { lines, newOffset } = window;
    if (newOffset === offset) {
      return;
    }
    let events: ConformantEvent[] = [];
    let covered = offset;
    for (const { text, end } of lines) {
      const entry = safeJsonLine(text);
      if (isAssistantEntry(entry)) {
        turns += 1;
        events.push(mintTurn(template, entry, turns));
      }
      covered = end;
      if (events.length >= opts.chunkSize) {
        yield { commit: commitAt(covered, turns), events };
        doneAt = covered;
        events = [];
        if (opts.shouldStop()) {
          stoppedAtDeadline();
          return;
        }
      }
    }
    yield { commit: commitAt(newOffset, turns), events };
    offset = newOffset;
    doneAt = newOffset;
  }
  stoppedAtDeadline();
}

export const claudeCodeAdapter: HookAdapter = {
  ...base,

  mapBatch(kind: string, raw: Record<string, unknown>): ConformantEvent[] | null {
    // Only `stop`. SubagentStop deliberately does NOT read the transcript: a
    // subagent's turns are written into the SAME file as sidechain entries, so the
    // main Stop's incremental read already picks them up. Reading from both would
    // race on one cursor and emit each subagent turn twice.
    return kind === 'stop' ? stopWithUsage(raw) : null;
  },

  // SessionEnd's usage is bulk work done AFTER its own event is queued: see `tail`.
  tail(kind, raw, opts) {
    return sessionEndTail(kind === 'session-end' ? raw : {}, opts);
  },
};

/**
 * Claude Code's hook payload → canonical Event. Thin wrapper over the adapter,
 * kept because the queue and the mapping tests address it by name.
 *
 * Single-event mapping only — it does NOT go through `mapBatch`, so it never
 * carries per-turn usage. `hook-entry` is the caller that sees the batch.
 */
export function toEvent(kind: HookKind, raw: ClaudeCodeHookPayload): Event {
  return claudeCodeAdapter.mapPayload(kind, raw) as Event;
}
