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
import { readNewLines, safeJsonLine } from '../lib/tail-read';
import type { ConformantEvent, HookAdapter } from './index';
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
 * Claude Code registers no SessionEnd hook, so unlike codex and gemini there is no
 * moment at which a session's state can be dropped on purpose — without a sweep
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
      const turn = assistantTurn(entry);
      events.push({
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
        turn_number: turns,
      } as ConformantEvent);
    }

    // Committed only once the events exist: advancing eagerly would consume a
    // turn's entries and then lose them if anything above threw.
    writeCursor(template.session_id, { offset: newOffset, path: transcriptPath, turns });
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
// Ownership marker: the binary name in the `command` field. User hooks that
// happen to contain "aiot" as a substring would also match, but the exec form
// (`command: "/usr/local/bin/aiot"`) makes false positives extremely unlikely.
const OWNERSHIP_MARKER = 'aiot';

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
      merged[event] = Array.isArray(entries) ? stripOwnedEntries(entries, OWNERSHIP_MARKER) : [];
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

function removeClaudeCode(): boolean {
  const settingsPath = CLAUDE_SETTINGS_PATH();
  try {
    const existing = readJsonFile<Record<string, unknown>>(settingsPath);
    if (!existing) {
      return true;
    }
    const hooks = (existing.hooks as Record<string, unknown[]>) ?? {};
    const cleaned: Record<string, unknown[]> = {};
    let hadAny = false;
    for (const [event, entries] of Object.entries(hooks)) {
      const stripped = Array.isArray(entries)
        ? stripOwnedEntries(entries, OWNERSHIP_MARKER)
        : entries;
      if (Array.isArray(stripped)) {
        if (stripped.length !== entries.length) {
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
      return true;
    }
    writeJsonFile(settingsPath, { ...existing, hooks: cleaned });
    removeBackup(settingsPath);
    return true;
  } catch (err) {
    process.stderr.write(`Error removing Claude Code hooks: ${(err as Error).message}\n`);
    return false;
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
  // Claude Code ships the transcript at Stop. The path + session id come from the
  // hook payload (transcript_path / session_id), not a computed location.
  transcriptKinds: ['stop'],
});

export const claudeCodeAdapter: HookAdapter = {
  ...base,

  mapBatch(kind: string, raw: Record<string, unknown>): ConformantEvent[] | null {
    // Only `stop`. SubagentStop deliberately does NOT read the transcript: a
    // subagent's turns are written into the SAME file as sidechain entries, so the
    // main Stop's incremental read already picks them up. Reading from both would
    // race on one cursor and emit each subagent turn twice.
    return kind === 'stop' ? stopWithUsage(raw) : null;
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
