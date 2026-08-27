import {
  type Event,
  type ToolInfo,
  toolActionFor,
  toolCategory,
  toolTargetHash,
} from '@ai-agents-observability/schemas';
import { fieldBytes } from './bytes';
import {
  assistantTurn,
  llmFromEntry,
  normalizeTs,
  stopIdSeed,
  toolUseIdsMetadata,
  toolUseIdsOf,
} from './claude-turns';
import { clientInfo } from './client-info';
import { userIdClaim } from './identity';
import type { ClaudeEntry, MessageContent } from './transcript-parser';
import { deterministicEventId } from './uuid5';

/** What a tool_use block's later PostToolUse needs in order to link back. */
export type ToolOrigin = {
  /** The issuing turn's Stop event_id — the tool event's `parent_event_id`. */
  parentEventId: string;
  toolName: string;
  turnNumber: number;
};

export type SynthCtx = {
  sessionId: string;
  cwd: string;
  version: string | null;
  // Mutable map populated as we encounter tool_use entries so tool_result
  // entries can look up the tool name (stored in tool_use, not tool_result).
  toolNameMap: Map<string, string>; // tool_use_id → tool_name
  // The turn-linkage half of the same lookup (P14-003). A tool_result arrives in
  // a LATER entry than the assistant turn that issued it, so the issuing turn's
  // ordinal and Stop event_id have to be remembered here to reach it.
  toolOrigin: Map<string, ToolOrigin>; // tool_use_id → issuing turn
  // Assistant turns seen so far; `turn_number` is 1-based, so the next assistant
  // entry is turnsSeen + 1. Counted over the file in order, which is what makes
  // it agree with the live Stop path's ordinal (adapters/claude-code.ts).
  turnsSeen: number;
};

/**
 * Create a fresh SynthCtx. Call once per session, pass the same object
 * through all entryToEvents() calls for that session.
 */
export function createSynthCtx(sessionId: string, cwd: string, version: string | null): SynthCtx {
  return {
    cwd,
    sessionId,
    toolNameMap: new Map(),
    toolOrigin: new Map(),
    turnsSeen: 0,
    version,
  };
}

/**
 * Advance the turn counter for an assistant entry and register the tool_use
 * blocks it issued against that turn.
 */
function registerAssistantTurn(
  entry: ClaudeEntry,
  ctx: SynthCtx,
): { parentEventId: string; turnNumber: number } {
  ctx.turnsSeen += 1;
  const turnNumber = ctx.turnsSeen;
  const parentEventId = assistantTurn(entry).eventId;

  const content = entry.message?.content;
  if (Array.isArray(content)) {
    for (const block of content as MessageContent[]) {
      if (block.type === 'tool_use') {
        const toolBlock = block as { type: 'tool_use'; id: string; name: string };
        ctx.toolNameMap.set(toolBlock.id, toolBlock.name);
        ctx.toolOrigin.set(toolBlock.id, { parentEventId, toolName: toolBlock.name, turnNumber });
      }
    }
  }
  return { parentEventId, turnNumber };
}

/**
 * Record an entry's turn bookkeeping WITHOUT emitting events for it.
 *
 * `import --since` skips entries older than the cutoff but must still walk them,
 * because a tool_result inside the window can name a tool_use from before it.
 * Turn numbering has the same requirement and one more besides: the ordinal must
 * count every assistant entry in the file, or a `--since` import numbers turns
 * differently from a full import of the same session and the two disagree about
 * which Stop a tool belongs to. Both bookkeeping halves therefore live here, and
 * the skip path in commands/import.ts calls this rather than poking the maps.
 */
export function noteSkippedEntry(entry: ClaudeEntry, ctx: SynthCtx): void {
  if (entry.type === 'assistant') {
    registerAssistantTurn(entry, ctx);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildImportToolInfo(
  name: string,
  input: unknown,
  output: unknown,
  toolUseId: string | null,
): ToolInfo {
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

  const inputBytes = fieldBytes(input);
  const outputBytes = fieldBytes(output);

  return {
    action: toolActionFor(input),
    // Import synthesizes events from a Claude Code transcript only.
    category: toolCategory('CLAUDE_CODE', name, isMcp),
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
    target_hash: toolTargetHash(input),
    // Carried so an imported row is shaped exactly like a live one. It is not
    // *needed* here — import already knows the linkage and writes it inline —
    // which is precisely why it belongs: a re-import of a live session must not
    // produce a row that differs from the live one in a column the join reads.
    tool_use_id: toolUseId,
    was_denied: false,
    was_interrupted: false,
  };
}

/** A tool event's linkage, or an empty one when its issuing turn was never seen. */
function linkOf(origin: ToolOrigin | undefined): Linkage {
  return origin
    ? { parentEventId: origin.parentEventId, turnNumber: origin.turnNumber }
    : { parentEventId: null };
}

/** Turn linkage for one event, per the P14-003 contract. */
type Linkage = {
  /** The issuing turn's Stop event_id. Null on the Stop itself and on non-tool events. */
  parentEventId?: string | null;
  /** 1-based assistant-turn ordinal. Absent on events that belong to no turn. */
  turnNumber?: number;
};

function baseEvent(
  eventType: Event['event_type'],
  idSeed: string,
  ts: string,
  ctx: SynthCtx,
  link: Linkage = {},
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
    parent_event_id: link.parentEventId ?? null,
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
    turn_number: link.turnNumber,
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

      const events: Event[] = [];

      // If the content array also has text blocks, emit a UserPromptSubmit too
      const hasText = (content as MessageContent[]).some((b) => b.type === 'text');
      if (hasText) {
        events.push(baseEvent('UserPromptSubmit', `${entry.uuid ?? ts}:user`, ts, ctx) as Event);
      }

      // PostToolUse per tool_result block, linked back to the turn that issued the
      // call. An origin we never saw (a truncated head, a `--session` import of a
      // resumed file) leaves the linkage null rather than guessing a turn.
      for (const block of toolResultBlocks) {
        const toolResultBlock = block as {
          type: 'tool_result';
          tool_use_id: string;
          content: unknown;
        };
        const origin = ctx.toolOrigin.get(toolResultBlock.tool_use_id);
        const toolName = origin?.toolName ?? ctx.toolNameMap.get(toolResultBlock.tool_use_id);
        const base = baseEvent(
          'PostToolUse',
          `${toolResultBlock.tool_use_id}:posttool`,
          ts,
          ctx,
          linkOf(origin),
        );
        events.push({
          ...base,
          tool: buildImportToolInfo(
            toolName ?? 'unknown',
            undefined,
            toolResultBlock.content,
            toolResultBlock.tool_use_id,
          ),
        } as Event);
      }

      return events;
    }

    case 'assistant': {
      const events: Event[] = [];

      // One assistant entry is one turn. This is also the point at which the turn's
      // tool_use blocks are registered, so the tool_result that lands in a later
      // entry can find its way back here.
      const { turnNumber } = registerAssistantTurn(entry, ctx);

      // Always emit a Stop event. `parent_event_id` is null on it by contract —
      // the Stop IS the turn; it is what the turn's tool events point at.
      const stopBase = baseEvent('Stop', stopIdSeed(entry, ts), ts, ctx, { turnNumber });
      // The same `tool_use_ids` the live Stop path writes (P14-006). Import does
      // not need it — its tool events already carry the linkage inline — but the
      // two paths dedupe on `(event_id, ts)`, so whichever wins the race decides
      // what the row's metadata says. Writing it on both makes that a non-question.
      Object.assign(stopBase.metadata, toolUseIdsMetadata(toolUseIdsOf(entry)));
      const llm = llmFromEntry(entry);
      events.push((llm ? { ...stopBase, llm } : stopBase) as Event);

      // Emit PreToolUse per tool_use block, carrying this turn's linkage.
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
            const preBase = baseEvent(
              'PreToolUse',
              `${toolBlock.id}:pretool`,
              ts,
              ctx,
              linkOf(ctx.toolOrigin.get(toolBlock.id)),
            );
            const preEvent: Event = {
              ...preBase,
              tool: buildImportToolInfo(toolBlock.name, toolBlock.input, undefined, toolBlock.id),
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
      const origin = ctx.toolOrigin.get(toolUseId);
      const toolName = origin?.toolName ?? ctx.toolNameMap.get(toolUseId) ?? 'unknown';
      const base = baseEvent('PostToolUse', `${toolUseId}:posttool`, ts, ctx, linkOf(origin));
      return [
        {
          ...base,
          // `toolUseId` above falls back to `ts` purely to key the lookup maps
          // for an entry that carries no id. That fallback must NOT reach the
          // column: it is not an id any other row will ever name, and writing it
          // would put a timestamp in the join key's namespace.
          tool: buildImportToolInfo(
            toolName,
            undefined,
            entry.output,
            typeof entry.tool_use_id === 'string' ? entry.tool_use_id : null,
          ),
        } as Event,
      ];
    }

    default: {
      return [];
    }
  }
}
