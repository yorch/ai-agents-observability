import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Event, EventType, ToolInfo } from '@ai-agents-observability/schemas';

import { fieldBytes } from '../lib/bytes';
import { log } from '../lib/log';
import { telemetryHome } from '../lib/paths';
import { NIL_UUID, sessionUuid } from '../lib/session-id';
import type { ConformantEvent, HookAdapter } from './index';
import {
  buildGenericToolInfo,
  createStdinHookAdapter,
  type FieldAliases,
} from './stdin-hook-factory';

// Gemini CLI adapter (P12-005). Gemini's hooks are configured in settings.json and
// hand a Claude-shaped payload to a command on stdin — `session_id`,
// `transcript_path`, `cwd`, `hook_event_name`, `timestamp` — so capture is the
// stdin-hook factory plus two Gemini-specific pieces: its own event names, and a
// usage accumulator (below).
//
// Lifecycle mapping (gemini event → canonical EventType):
//   SessionStart / SessionEnd  → SessionStart / SessionEnd
//   BeforeTool  / AfterTool    → PreToolUse / PostToolUse
//   BeforeAgent / AfterAgent   → UserPromptSubmit / Stop
//   PreCompress                → PreCompact
//   Notification               → Notification
//   AfterModel                 → (no event; harvested for token usage — see below)
// BeforeModel and BeforeToolSelection have no canonical equivalent and are not
// registered; we never synthesize a non-schema event_type.

const GEMINI_EVENT_TYPE: Record<string, EventType> = {
  'after-agent': 'Stop',
  'after-tool': 'PostToolUse',
  'before-agent': 'UserPromptSubmit',
  'before-tool': 'PreToolUse',
  notification: 'Notification',
  'pre-compress': 'PreCompact',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
};

/** Registered so `hook after-model` is accepted, but it emits no event. */
const USAGE_KIND = 'after-model';

const HOOK_KIND_TO_GEMINI_EVENT: Record<string, string> = {
  'after-agent': 'AfterAgent',
  'after-model': 'AfterModel',
  'after-tool': 'AfterTool',
  'before-agent': 'BeforeAgent',
  'before-tool': 'BeforeTool',
  notification: 'Notification',
  'pre-compress': 'PreCompress',
  'session-end': 'SessionEnd',
  'session-start': 'SessionStart',
};

// Captured structurally by buildGeminiToolInfo, so not duplicated into metadata.
// (The alias keys — session_id, cwd, tool_*, transcript_path — are known
// automatically; the factory unions them in.)
const GEMINI_KNOWN_KEYS = ['mcp_context', 'original_request_name'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

// ── Tool block ────────────────────────────────────────────────────────────────

// Gemini is the first agent to hand us MCP context at the tool boundary, filling
// `mcp_server` / `mcp_tool` — fields opencode and codex both leave null.
//
// CAUTION: the docs name `mcp_context` and `original_request_name` but do not
// specify mcp_context's inner fields, so the server name is read across the
// plausible spellings and simply left null when none match. Verify against a real
// Gemini MCP session before relying on it.
function serverFromMcpContext(mcpContext: unknown): string | null {
  if (!isRecord(mcpContext)) {
    return null;
  }
  for (const key of ['server_name', 'serverName', 'server', 'name']) {
    const value = mcpContext[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function buildGeminiToolInfo(raw: Record<string, unknown>, aliases: FieldAliases): ToolInfo {
  const tool = buildGenericToolInfo(raw, aliases);
  const response = raw.tool_response;

  // AfterTool's tool_response is { llmContent, returnDisplay, error? }. Size the
  // model-visible half rather than the whole envelope, and surface a failed call
  // through exit_status so error rates aggregate the same way as other agents'.
  if (isRecord(response)) {
    const content = response.llmContent ?? response.returnDisplay ?? null;
    tool.output_bytes = fieldBytes(content);
    if (response.error != null) {
      tool.exit_status = 1;
    }
  }

  const mcpServer = serverFromMcpContext(raw.mcp_context);
  if (mcpServer !== null) {
    tool.category = 'mcp';
    tool.mcp_server = mcpServer;
    // `original_request_name` is the tool's name as the MCP server exposes it,
    // before Gemini's own prefixing.
    tool.mcp_tool =
      typeof raw.original_request_name === 'string' ? raw.original_request_name : tool.name;
  }
  return tool;
}

// ── Usage accumulation ────────────────────────────────────────────────────────
//
// Gemini reports token usage on AfterModel — once per LLM call — while cost is
// attributed per turn. AfterModel has no canonical event type of its own, so it is
// harvested rather than emitted: each AfterModel adds to a small per-session
// accumulator, and the turn's Stop (AfterAgent) drains it into one `llm` block.
//
// CAUTION: the docs describe `llm_response` as an object but do not enumerate its
// fields. The readers below cover Gemini's public API shape (`usageMetadata` with
// promptTokenCount / candidatesTokenCount / cachedContentTokenCount) and the
// generic spellings. When nothing matches, no usage is recorded and the Stop
// simply carries no `llm` block — never a wrong number.

type Usage = {
  cacheRead: number;
  input: number;
  model: string | null;
  output: number;
};

const EMPTY_USAGE: Usage = { cacheRead: 0, input: 0, model: null, output: 0 };

export function geminiUsageDir(): string {
  return join(telemetryHome(), 'gemini-usage');
}

function usagePath(sessionId: string): string {
  return join(geminiUsageDir(), `${sessionId}.jsonl`);
}

function extractUsage(raw: Record<string, unknown>): Usage | null {
  const response = isRecord(raw.llm_response) ? raw.llm_response : null;
  if (!response) {
    return null;
  }
  const meta = [response.usageMetadata, response.usage_metadata, response.usage].find(isRecord);
  if (!meta) {
    return null;
  }
  const model =
    (typeof response.model === 'string' ? response.model : null) ??
    (typeof raw.model === 'string' ? raw.model : null) ??
    modelFromRequest(raw);

  const input = num(meta.promptTokenCount ?? meta.prompt_token_count ?? meta.input_tokens);
  const output = num(
    meta.candidatesTokenCount ?? meta.candidates_token_count ?? meta.output_tokens,
  );
  const cacheRead = num(
    meta.cachedContentTokenCount ?? meta.cached_content_token_count ?? meta.cache_read_tokens,
  );
  if (input === 0 && output === 0 && cacheRead === 0) {
    return null;
  }
  return { cacheRead, input, model, output };
}

function modelFromRequest(raw: Record<string, unknown>): string | null {
  const request = isRecord(raw.llm_request) ? raw.llm_request : null;
  return request && typeof request.model === 'string' ? request.model : null;
}

// APPEND-ONLY, one line per AfterModel. Hooks are separate processes and Gemini
// can issue several model calls per turn, so a read-modify-write accumulator
// loses tokens whenever two of them interleave (measured: ~20% under-report at 10
// concurrent calls). A single `appendFileSync` of a short line is atomic under
// O_APPEND on Linux and macOS, so concurrent writers interleave lines rather than
// clobbering each other's totals.
function addUsage(sessionId: string, usage: Usage): void {
  const path = usagePath(sessionId);
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  appendFileSync(path, `${JSON.stringify(usage)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readUsage(sessionId: string): Usage {
  let text: string;
  try {
    text = readFileSync(usagePath(sessionId), 'utf8');
  } catch {
    return EMPTY_USAGE; // no usage recorded for this session yet
  }
  const total = { ...EMPTY_USAGE };
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn final line (killed mid-append) costs one call, not the turn
    }
    if (!isRecord(parsed)) {
      continue;
    }
    total.cacheRead += num(parsed.cacheRead);
    total.input += num(parsed.input);
    total.output += num(parsed.output);
    total.model = typeof parsed.model === 'string' ? parsed.model : total.model;
  }
  return total;
}

/**
 * Read the turn's accumulated usage, then clear it. The read comes first and the
 * removal is best-effort: if the file cannot be removed we still return what was
 * read, because losing the event is worse than the (visible) risk of counting the
 * same tokens twice. Removal failure is not silent — the caller logs it.
 */
function drainUsage(sessionId: string): { removed: boolean; usage: Usage } {
  const usage = readUsage(sessionId);
  try {
    rmSync(usagePath(sessionId), { force: true });
    return { removed: true, usage };
  } catch {
    return { removed: false, usage };
  }
}

function llmBlock(usage: Usage): NonNullable<Event['llm']> {
  return {
    cache_creation_tokens: 0,
    cache_read_tokens: usage.cacheRead,
    cost_usd: 0, // computed ingest-side from the gemini_cli price table (P8-002)
    input_tokens: usage.input,
    model: usage.model ?? 'unknown',
    output_tokens: usage.output,
  };
}

// ── Install ───────────────────────────────────────────────────────────────────

function renderSnippet(bin: string): string {
  const hooks: Record<string, unknown[]> = {};
  for (const [kind, geminiEvent] of Object.entries(HOOK_KIND_TO_GEMINI_EVENT)) {
    hooks[geminiEvent] = [
      {
        hooks: [
          {
            command: `${JSON.stringify(bin)} hook ${kind} --agent gemini-cli`,
            name: `claude-telemetry-${kind}`,
            timeout: 5000,
            type: 'command',
          },
        ],
      },
    ];
  }
  return JSON.stringify({ hooks }, null, 2);
}

// ── Adapter ───────────────────────────────────────────────────────────────────

const base = createStdinHookAdapter({
  agentType: 'GEMINI_CLI',
  buildTool: buildGeminiToolInfo,
  eventMap: GEMINI_EVENT_TYPE,
  install: {
    agentName: 'Gemini CLI',
    renderSnippet,
    settingsHint: 'Add to ~/.gemini/settings.json (or .gemini/settings.json in a project):',
  },
  knownKeys: GEMINI_KNOWN_KEYS,
  transcriptKinds: ['after-agent', 'session-end'],
});

export const geminiCliAdapter: HookAdapter = {
  ...base,

  installConfig() {
    // `after-model` is a real hook we register but never turn into an event.
    return { ...base.installConfig(), hookKinds: Object.keys(HOOK_KIND_TO_GEMINI_EVENT) };
  },

  isHookKind(value: string): boolean {
    return value === USAGE_KIND || base.isHookKind(value);
  },

  mapBatch(kind: string, raw: Record<string, unknown>): ConformantEvent[] | null {
    // AfterModel: harvest usage, emit nothing. Returning [] (not null) is what
    // tells the transport "handled, no events" rather than falling through to
    // mapPayload, which would invent a Notification. hook-entry uses `??`, so an
    // empty array is respected — `hook-entry.test.ts` pins that.
    if (kind === USAGE_KIND) {
      try {
        const sessionId = sessionUuid('GEMINI_CLI', raw.session_id);
        // Without a session id every session would accumulate into ONE nil-keyed
        // file and drain onto whichever Stop got there first. Drop instead.
        if (sessionId === NIL_UUID) {
          log('warn', 'gemini.usage.no_session_id', {});
          return [];
        }
        const usage = extractUsage(raw);
        if (usage) {
          addUsage(sessionId, usage);
        }
      } catch (err) {
        log('warn', 'gemini.usage.record_failed', { message: (err as Error).message });
      }
      return [];
    }
    const eventType = GEMINI_EVENT_TYPE[kind];
    if (eventType !== 'Stop' && eventType !== 'SessionEnd') {
      return null;
    }
    // AfterAgent: drain the turn's accumulated usage onto the Stop. SessionEnd
    // drains too — without that, a session whose last turn never reaches
    // AfterAgent (Ctrl-C, crash) leaks its accumulator file forever.
    let event: ConformantEvent;
    try {
      event = base.mapPayload(kind, raw);
    } catch {
      return null;
    }
    if (event.session_id === NIL_UUID) {
      return [event];
    }
    const { removed, usage } = drainUsage(event.session_id);
    if (!removed) {
      log('warn', 'gemini.usage.drain_not_cleared', { session_id: event.session_id });
    }
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0) {
      return [event];
    }
    return [{ ...event, llm: llmBlock(usage) } as ConformantEvent];
  },
};
