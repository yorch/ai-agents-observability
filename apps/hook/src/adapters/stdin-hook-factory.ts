import {
  type AgentType,
  canonicalPermissionMode,
  type EventType,
  type ToolInfo,
  toolActionFor,
  toolCategory,
  toolTargetHash,
} from '@ai-agents-observability/schemas';

import { fieldBytes } from '../lib/bytes';
import { clientInfo } from '../lib/client-info';
import { pickString, pickValue } from '../lib/fields';
import { userIdClaim } from '../lib/identity';
import { sessionUuid } from '../lib/session-id';
import { uuidv7 } from '../lib/uuid';
import type { AdapterInstallConfig, ConformantEvent, HookAdapter, TranscriptTarget } from './index';

// The stdin-hook adapter factory (P12-003).
//
// When P8-003 extracted the seam, Claude Code's hook protocol was Claude's alone.
// It isn't any more: Codex, Gemini CLI, and Copilot CLI all now hand a JSON payload
// to a command on stdin, with the same base fields —
//
//   session_id · transcript_path · cwd · hook_event_name
//   tool_name · tool_input · tool_response
//
// — differing only in event NAMES (Gemini's `BeforeTool`, Copilot's `preToolUse`)
// and field SPELLING (Copilot's camelCase `sessionId` / `toolArgs`). That is a
// configuration difference, not four integrations, so this factory owns assembly
// and each agent contributes a config object.
//
// Scope discipline: this is for agents that differ only in NAMING. An agent that
// needs real logic — opencode, pi, omp (plugin-shaped), codex's rollout usage read —
// writes its own adapter and uses the exported helpers instead. Do not grow this
// config into a programming language.

// Every field named here is READ by the factory. Do not add an alias the factory
// does not consume: alias names are excluded from metadata (they are supposed to be
// captured structurally), so an unread alias silently swallows that payload key.
export type FieldAliases = {
  cwd: string[];
  permissionMode: string[];
  sessionId: string[];
  toolInput: string[];
  toolName: string[];
  toolResponse: string[];
  transcriptPath: string[];
};

/** Claude-shaped defaults; an agent overrides only the fields it spells differently. */
export const DEFAULT_FIELD_ALIASES: FieldAliases = {
  cwd: ['cwd'],
  permissionMode: ['permission_mode'],
  sessionId: ['session_id'],
  toolInput: ['tool_input'],
  toolName: ['tool_name'],
  toolResponse: ['tool_response'],
  transcriptPath: ['transcript_path'],
};

export type StdinHookConfig = {
  /**
   * Canonical agent_type stamped on events. Typed as `AgentType` rather than
   * `string` on purpose: the assembled event needs an `as ConformantEvent` cast
   * (event_type is dynamic), which would otherwise let a typo'd agent type
   * compile and ship a binary whose every event ingest rejects.
   */
  agentType: AgentType;
  /**
   * Optional per-agent tool-block builder. Defaults to `buildGenericToolInfo`.
   * Claude Code passes its own so its long-standing behavior is untouched.
   * Receives the hook `kind` — the authoritative signal for things a payload may
   * not restate (Copilot's postToolUseFailure, for one).
   */
  buildTool?: (raw: Record<string, unknown>, aliases: FieldAliases, kind: string) => ToolInfo;
  /**
   * Optional per-agent enrichment, applied last. Mutates the assembled event —
   * for metadata an agent derives (Claude's slash_command / notification_kind).
   */
  enrich?: (event: ConformantEvent, kind: string, raw: Record<string, unknown>) => void;
  /** Hook kind (our kebab-case CLI arg) → canonical EventType. */
  eventMap: Record<string, EventType>;
  /** Field spellings this agent uses; merged over DEFAULT_FIELD_ALIASES. */
  fields?: Partial<FieldAliases>;
  /** Metadata for the `install` command. */
  install: Omit<AdapterInstallConfig, 'hookKinds'>;
  /**
   * Hook kind → the agent's own event name, for agents whose set of INSTALLED
   * hooks is not exactly the set that produces events. Gemini's `AfterModel` is
   * the case: it must be installed and accepted, but it is harvested for token
   * usage and emits nothing, so it cannot appear in `eventMap`.
   *
   * When present this drives `installConfig().hookKinds` and widens
   * `isHookKind`; `eventMap` stays the event-producing subset.
   */
  nativeEvents?: Record<string, string>;
  /**
   * EXTRA payload keys captured structurally (and so NOT copied into metadata).
   * The alias keys and `hook_event_name` are always known; this adds to them, so
   * an agent cannot accidentally re-emit into metadata something the factory
   * already captured (`permission_mode` → session_context.mode, for one).
   */
  knownKeys?: string[];
  /** Hook kinds that ship a transcript. Empty/omitted = this agent ships none. */
  transcriptKinds?: string[];
};

/**
 * Tool block from a Claude-shaped payload: name, MCP split, byte sizes. Only what
 * is knowable at capture time — duration/exit are filled downstream or defaulted.
 *
 * `agentType` drives the per-agent tool-category lookup (`toolCategory()`) —
 * required because this one function serves every stdin agent that doesn't
 * override `buildTool`, and their tool-name vocabularies don't overlap.
 */
export function buildGenericToolInfo(
  raw: Record<string, unknown>,
  aliases: FieldAliases,
  _kind: string | undefined,
  agentType: AgentType,
): ToolInfo {
  const name = pickString(raw, aliases.toolName) ?? 'unknown';
  const input = pickValue(raw, aliases.toolInput);
  const output = pickValue(raw, aliases.toolResponse);

  const isMcp = name.startsWith('mcp__');
  let mcpServer: string | null = null;
  let mcpTool: string | null = null;
  if (isMcp) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep >= 0) {
      mcpServer = rest.slice(0, sep);
      mcpTool = rest.slice(sep + 2);
    }
  }

  return {
    // Content-free capture (P13-003). Derived from the target/command field of
    // the tool input only — never the whole input, never the output — so
    // DESIGN_DOC §9.3 holds. Living in the shared factory rather than each
    // adapter means every stdin agent gets it: without this, the three
    // trajectory scorers keyed on a target (edit thrash, redundant re-read,
    // tests-before-merge) would be silently dead for Gemini CLI, Copilot CLI
    // and Codex while working for Claude Code.
    action: toolActionFor(input),
    // isMcp, not mcpServer: a name like `mcp__server` (no tool segment) parses
    // no server but is still an MCP tool — see payload.ts's identical rule.
    category: toolCategory(agentType, name, isMcp),
    duration_ms: 0,
    exit_status: null,
    input_bytes: fieldBytes(input),
    input_hash: null,
    mcp_server: mcpServer,
    mcp_tool: mcpTool,
    name,
    output_bytes: fieldBytes(output),
    skill: null,
    slash_command: null,
    subagent_type: null,
    target_hash: toolTargetHash(input),
    // Deliberately null here rather than read from a `tool_use_id` alias.
    // P14-006 promoted that key for Claude Code because its transcript repeats
    // the SAME id on the `tool_use` block, which is what makes the server-side
    // join sound. An agent whose id has no such counterpart would be shipping a
    // key nothing can join on, so each adapter adopts it when its own side
    // channel does — see `lib/payload.ts` for the one that has.
    tool_use_id: null,
    was_denied: raw.tool_denied === true || raw.was_denied === true,
    was_interrupted: raw.was_interrupted === true,
  };
}

export function createStdinHookAdapter(config: StdinHookConfig): HookAdapter {
  const aliases: FieldAliases = { ...DEFAULT_FIELD_ALIASES, ...config.fields };
  const buildTool =
    config.buildTool ??
    ((raw, toolAliases, kind) => buildGenericToolInfo(raw, toolAliases, kind, config.agentType));
  const transcriptKinds = new Set(config.transcriptKinds ?? []);
  // Every kind we ask the agent to install. A superset of eventMap when the agent
  // has a hook that is captured but produces no event.
  const installedKinds = new Set([
    ...Object.keys(config.eventMap),
    ...Object.keys(config.nativeEvents ?? {}),
  ]);
  // Alias keys are ALWAYS known — they are captured structurally, so re-emitting
  // them into metadata would duplicate the value under a second name. An agent's
  // own `knownKeys` adds to that set rather than replacing it.
  const knownKeys = new Set([
    'hook_event_name',
    ...Object.values(aliases).flat(),
    ...(config.knownKeys ?? []),
  ]);

  // Everything we did not capture structurally rides along in metadata, so a
  // payload field we have not modelled yet is preserved rather than dropped.
  const buildMetadata = (raw: Record<string, unknown>): Record<string, unknown> => {
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!knownKeys.has(key)) {
        meta[key] = value;
      }
    }
    const transcriptPath = pickString(raw, aliases.transcriptPath);
    if (transcriptPath) {
      meta.transcript_path = transcriptPath;
    }
    return meta;
  };

  const mapPayload = (kind: string, raw: Record<string, unknown>): ConformantEvent => {
    const eventType = config.eventMap[kind] ?? 'Notification';
    const isToolEvent = eventType === 'PreToolUse' || eventType === 'PostToolUse';

    const event = {
      agent_type: config.agentType,
      client: clientInfo(),
      event_id: uuidv7(),
      event_type: eventType,
      metadata: buildMetadata(raw),
      redaction_flags: [],
      schema_version: 1,
      session_context: {
        cwd: pickString(raw, aliases.cwd) ?? process.cwd(),
        // Enriched by the flusher / session-start cache, not per event.
        git: null,
        is_resume: false,
        mode: canonicalPermissionMode(pickValue(raw, aliases.permissionMode)),
      },
      session_id: sessionUuid(config.agentType, pickValue(raw, aliases.sessionId)),
      ...(isToolEvent ? { tool: buildTool(raw, aliases, kind) } : {}),
      ts: new Date().toISOString(),
      user_id_claim: userIdClaim(),
      // `event_type` is dynamic, which TypeScript cannot narrow against the
      // discriminated union without a cast. Ingest re-validates with EventSchema,
      // and every adapter test asserts conformance (conformance.ts).
    } as ConformantEvent;

    config.enrich?.(event, kind, raw);
    return event;
  };

  return {
    agentType: config.agentType,

    installConfig(): AdapterInstallConfig {
      return { ...config.install, hookKinds: [...installedKinds] };
    },

    isHookKind(value: string): boolean {
      return installedKinds.has(value);
    },

    mapPayload,

    transcriptTarget(kind: string, raw: Record<string, unknown>): TranscriptTarget | null {
      if (!transcriptKinds.has(kind)) {
        return null;
      }
      const transcriptPath = pickString(raw, aliases.transcriptPath);
      const nativeSessionId = pickValue(raw, aliases.sessionId);
      if (!transcriptPath || typeof nativeSessionId !== 'string' || nativeSessionId.length === 0) {
        return null;
      }
      // Normalized exactly as the event's session_id is, so the transcript keys to
      // the session its events landed under (P12-002).
      return { sessionId: sessionUuid(config.agentType, nativeSessionId), transcriptPath };
    },
  };
}
