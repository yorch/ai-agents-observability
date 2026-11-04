export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  /** The tool reported failure (`is_error: true` on the result block). */
  isError?: boolean;
  toolName?: string;
};

export type TextBlock = {
  type: 'text';
  text: string;
};

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

export type ParsedLine =
  | { kind: 'user-message'; content: string; timestamp?: string; src: unknown }
  | {
      kind: 'tool-results';
      results: ToolResultBlock[];
      /**
       * Text blocks that rode on the same user line as the results (an
       * interruption note, typically). Kept so the line is not silently lost;
       * not counted as a prompt.
       */
      note?: string;
      timestamp?: string;
      src: unknown;
    }
  | {
      kind: 'assistant-turn';
      blocks: ContentBlock[];
      usage?: TokenUsage;
      model?: string;
      timestamp?: string;
      src: unknown;
    }
  | { kind: 'metadata'; lineType: string; src: unknown };

export type TranscriptStats = {
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  outputTokens: number;
  models: string[];
  firstTimestamp?: string;
  lastTimestamp?: string;
};

// Claude Code writes these as a user line when the person interrupts a turn.
// They are not prompts: render them as the muted note shape (a tool-results
// line with no results), and keep them out of the user-turn count.
const INTERRUPT_MARKER = /^\[Request interrupted by user( for tool use)?\]$/;

function interruptNote(note: string, src: unknown, timestamp: string | undefined): ParsedLine {
  return {
    kind: 'tool-results',
    note,
    results: [],
    src,
    ...(timestamp !== undefined && { timestamp }),
  };
}

/**
 * Parse one raw NDJSON line into a typed ParsedLine.
 * toolNameMap is mutated in-place: assistant turns register tool_use ids so
 * subsequent tool_result lines can resolve the tool name.
 */
export function parseTranscriptLine(rawLine: string, toolNameMap: Map<string, string>): ParsedLine {
  let obj: unknown;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return { kind: 'metadata', lineType: 'unparseable', src: { raw: rawLine } };
  }

  if (!obj || typeof obj !== 'object') {
    return { kind: 'metadata', lineType: 'unknown', src: obj };
  }

  const line = obj as Record<string, unknown>;
  const type = line.type as string | undefined;
  const message = line.message as Record<string, unknown> | undefined;
  const timestamp = line.timestamp as string | undefined;

  if (type === 'user' && message) {
    // Harness-injected lines (caveats, expanded slash-command bodies) are not
    // something the person typed — never a prompt.
    if (line.isMeta === true) {
      return { kind: 'metadata', lineType: 'meta', src: obj };
    }
    const content = message.content;
    if (typeof content === 'string') {
      if (INTERRUPT_MARKER.test(content.trim())) {
        return interruptNote(content.trim(), obj, timestamp);
      }
      return {
        content,
        kind: 'user-message',
        src: obj,
        ...(timestamp !== undefined && { timestamp }),
      };
    }
    if (Array.isArray(content)) {
      const toolResults: ToolResultBlock[] = [];
      const texts: string[] = [];
      for (const b of content as unknown[]) {
        if (!b || typeof b !== 'object') {
          continue;
        }
        const block = b as Record<string, unknown>;
        if (block.type === 'tool_result') {
          const toolUseId = block.tool_use_id as string | undefined;
          const toolName = toolUseId ? toolNameMap.get(toolUseId) : undefined;
          toolResults.push({
            content: block.content,
            tool_use_id: toolUseId ?? '',
            type: 'tool_result' as const,
            ...(block.is_error === true && { isError: true }),
            ...(toolName !== undefined && { toolName }),
          });
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          texts.push(block.text);
        }
      }
      if (toolResults.length > 0) {
        return {
          kind: 'tool-results',
          results: toolResults,
          src: obj,
          ...(texts.length > 0 && { note: texts.join('\n\n') }),
          ...(timestamp !== undefined && { timestamp }),
        };
      }
      // A prompt carried as text blocks rather than a bare string is still a
      // prompt — the hook's own importer maps exactly this shape to
      // UserPromptSubmit (apps/hook/src/lib/import-synth.ts).
      if (texts.length > 0) {
        const joined = texts.join('\n\n');
        if (INTERRUPT_MARKER.test(joined.trim())) {
          return interruptNote(joined.trim(), obj, timestamp);
        }
        return {
          content: texts.join('\n\n'),
          kind: 'user-message',
          src: obj,
          ...(timestamp !== undefined && { timestamp }),
        };
      }
    }
  }

  if (type === 'assistant' && message) {
    const rawContent = message.content;
    const blocks: ContentBlock[] = Array.isArray(rawContent)
      ? rawContent.map((b: unknown) => {
          const block = b as Record<string, unknown>;
          if (block.type === 'tool_use') {
            const toolUse: ToolUseBlock = {
              id: block.id as string,
              input: block.input,
              name: block.name as string,
              type: 'tool_use',
            };
            if (toolUse.id) {
              toolNameMap.set(toolUse.id, toolUse.name);
            }
            return toolUse;
          }
          return block as ContentBlock;
        })
      : [];

    const rawUsage = message.usage as Record<string, number> | undefined;
    const usage: TokenUsage | undefined = rawUsage
      ? {
          cacheReadTokens: rawUsage.cache_read_input_tokens ?? 0,
          inputTokens: (rawUsage.input_tokens ?? 0) + (rawUsage.cache_creation_input_tokens ?? 0),
          outputTokens: rawUsage.output_tokens ?? 0,
        }
      : undefined;

    const model = message.model as string | undefined;
    return {
      blocks,
      kind: 'assistant-turn',
      src: obj,
      ...(model !== undefined && { model }),
      ...(timestamp !== undefined && { timestamp }),
      ...(usage !== undefined && { usage }),
    };
  }

  return { kind: 'metadata', lineType: type ?? 'unknown', src: obj };
}

export function computeStats(lines: ParsedLine[]): TranscriptStats {
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let outputTokens = 0;
  const modelsSet = new Set<string>();
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  for (const line of lines) {
    const ts = 'timestamp' in line ? line.timestamp : undefined;
    if (ts) {
      if (!firstTimestamp) {
        firstTimestamp = ts;
      }
      lastTimestamp = ts;
    }
    if (line.kind === 'user-message') {
      userTurns++;
    } else if (line.kind === 'assistant-turn') {
      assistantTurns++;
      if (line.usage) {
        outputTokens += line.usage.outputTokens;
      }
      if (line.model) {
        modelsSet.add(line.model);
      }
      toolCalls += line.blocks.filter((b) => b.type === 'tool_use').length;
    }
  }

  return {
    assistantTurns,
    models: [...modelsSet],
    ...(firstTimestamp !== undefined && { firstTimestamp }),
    ...(lastTimestamp !== undefined && { lastTimestamp }),
    outputTokens,
    toolCalls,
    userTurns,
  };
}
