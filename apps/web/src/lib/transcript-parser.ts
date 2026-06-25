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
  | { kind: 'tool-results'; results: ToolResultBlock[]; timestamp?: string; src: unknown }
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
    const content = message.content;
    if (typeof content === 'string') {
      return {
        content,
        kind: 'user-message',
        src: obj,
        ...(timestamp !== undefined && { timestamp }),
      };
    }
    if (Array.isArray(content)) {
      const toolResults: ToolResultBlock[] = content
        .filter((b: unknown) => (b as Record<string, unknown>).type === 'tool_result')
        .map((b: unknown) => {
          const block = b as Record<string, unknown>;
          const toolUseId = block.tool_use_id as string | undefined;
          const toolName = toolUseId ? toolNameMap.get(toolUseId) : undefined;
          return {
            content: block.content,
            tool_use_id: toolUseId ?? '',
            type: 'tool_result' as const,
            ...(toolName !== undefined && { toolName }),
          };
        });
      if (toolResults.length > 0) {
        return {
          kind: 'tool-results',
          results: toolResults,
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
