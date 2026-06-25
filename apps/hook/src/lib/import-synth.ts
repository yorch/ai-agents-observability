import type { Event, ToolInfo } from '@ai-agents-observability/schemas';

import { clientInfo } from './client-info';
import { userIdClaim } from './identity';
import type { ClaudeEntry, MessageContent } from './transcript-parser';
import { deterministicEventId } from './uuid5';

export type SynthCtx = {
  sessionId: string;
  cwd: string;
  version: string | null;
  // Mutable map populated as we encounter tool_use entries so tool_result
  // entries can look up the tool name (stored in tool_use, not tool_result).
  toolNameMap: Map<string, string>; // tool_use_id → tool_name
};

/**
 * Create a fresh SynthCtx. Call once per session, pass the same object
 * through all entryToEvents() calls for that session.
 */
export function createSynthCtx(sessionId: string, cwd: string, version: string | null): SynthCtx {
  return { cwd, sessionId, toolNameMap: new Map(), version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildImportToolInfo(name: string, input: unknown, output: unknown): ToolInfo {
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

  const subagentType =
    name === 'Task' && isRecord(input) && typeof input.subagent_type === 'string'
      ? input.subagent_type
      : null;

  const inputBytes = input != null ? (JSON.stringify(input)?.length ?? 0) : 0;
  const outputBytes = output != null ? (JSON.stringify(output)?.length ?? 0) : 0;

  return {
    category: isMcp ? 'mcp' : 'builtin',
    duration_ms: 0,
    exit_status: null,
    input_bytes: inputBytes,
    input_hash: null,
    mcp_server: mcpServer,
    mcp_tool: mcpTool,
    name,
    output_bytes: outputBytes,
    skill: null,
    slash_command: null,
    subagent_type: subagentType,
    was_denied: false,
    was_interrupted: false,
  };
}

// Ensure ts has a timezone offset (z.iso.datetime({ offset: true }) requires it).
// Claude Code timestamps are typically ISO 8601 with 'Z' suffix already, but
// fall back gracefully if the field is absent or malformed.
function normalizeTs(ts: string | undefined): string {
  if (!ts) {
    return new Date().toISOString();
  }
  // Already has offset (+HH:MM or Z)
  if (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts)) {
    return ts;
  }
  // No offset — treat as UTC
  return `${ts}Z`;
}

function baseEvent(
  eventType: Event['event_type'],
  idSeed: string,
  ts: string,
  ctx: SynthCtx,
): Omit<Event, 'tool' | 'llm'> {
  return {
    agent_type: 'CLAUDE_CODE',
    client: clientInfo(),
    event_id: deterministicEventId(idSeed),
    event_type: eventType,
    metadata: {
      imported: true,
      source: 'claude-jsonl',
      ...(ctx.version ? { claude_code_version_import: ctx.version } : {}),
    },
    parent_event_id: null,
    redaction_flags: [],
    schema_version: 1,
    session_context: {
      cwd: ctx.cwd,
      git: null,
      is_resume: false,
      mode: 'normal',
    },
    session_id: ctx.sessionId,
    ts,
    turn_number: undefined,
    user_id_claim: userIdClaim(),
  } as Omit<Event, 'tool' | 'llm'>;
}

/**
 * Map ONE ClaudeEntry to zero or more Events.
 * Side effect: populates ctx.toolNameMap when tool_use blocks are seen.
 */
export function entryToEvents(entry: ClaudeEntry, ctx: SynthCtx): Event[] {
  const ts = normalizeTs(entry.timestamp);

  switch (entry.type) {
    case 'summary': {
      return [];
    }

    case 'user': {
      const content = entry.message?.content;
      if (content === undefined || content === null) {
        return [];
      }

      // String content or array of only text blocks → UserPromptSubmit
      if (typeof content === 'string') {
        const base = baseEvent('UserPromptSubmit', `${entry.uuid ?? ts}:user`, ts, ctx);
        return [base as Event];
      }

      // Array content: check for tool_result blocks
      const toolResultBlocks = (content as MessageContent[]).filter(
        (b) => b.type === 'tool_result',
      );

      if (toolResultBlocks.length === 0) {
        // Only text blocks (or empty array) → UserPromptSubmit
        const base = baseEvent('UserPromptSubmit', `${entry.uuid ?? ts}:user`, ts, ctx);
        return [base as Event];
      }

      // Has tool_result blocks → PostToolUse per block
      return toolResultBlocks.map((block) => {
        const toolResultBlock = block as {
          type: 'tool_result';
          tool_use_id: string;
          content: unknown;
        };
        const toolName = ctx.toolNameMap.get(toolResultBlock.tool_use_id) ?? 'unknown';
        const base = baseEvent('PostToolUse', `${toolResultBlock.tool_use_id}:posttool`, ts, ctx);
        return {
          ...base,
          tool: buildImportToolInfo(toolName, undefined, toolResultBlock.content),
        } as Event;
      });
    }

    case 'assistant': {
      const events: Event[] = [];
      const ts2 = ts;
      const usage = entry.message?.usage;

      // Always emit a Stop event
      const stopBase = baseEvent('Stop', `${entry.uuid ?? ts2}:stop`, ts2, ctx);
      if (usage) {
        const stopEvent: Event = {
          ...stopBase,
          llm: {
            cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_tokens: usage.cache_read_input_tokens ?? 0,
            cost_usd: 0,
            input_tokens: usage.input_tokens ?? 0,
            model: entry.message?.model ?? 'unknown',
            output_tokens: usage.output_tokens ?? 0,
          },
        } as Event;
        events.push(stopEvent);
      } else {
        events.push(stopBase as Event);
      }

      // Emit PreToolUse per tool_use block
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content as MessageContent[]) {
          if (block.type === 'tool_use') {
            const toolBlock = block as {
              type: 'tool_use';
              id: string;
              name: string;
              input: unknown;
            };
            // Register in toolNameMap for later PostToolUse lookup
            ctx.toolNameMap.set(toolBlock.id, toolBlock.name);
            const preBase = baseEvent('PreToolUse', `${toolBlock.id}:pretool`, ts2, ctx);
            const preEvent: Event = {
              ...preBase,
              tool: buildImportToolInfo(toolBlock.name, toolBlock.input, undefined),
            } as Event;
            events.push(preEvent);
          }
        }
      }

      return events;
    }

    case 'tool': {
      // Rare fallback entry type — same as tool_result blocks in 'user' entries
      const toolUseId = typeof entry.tool_use_id === 'string' ? entry.tool_use_id : ts;
      const toolName = ctx.toolNameMap.get(toolUseId) ?? 'unknown';
      const base = baseEvent('PostToolUse', `${toolUseId}:posttool`, ts, ctx);
      return [
        {
          ...base,
          tool: buildImportToolInfo(toolName, undefined, entry.output),
        } as Event,
      ];
    }

    default: {
      return [];
    }
  }
}
