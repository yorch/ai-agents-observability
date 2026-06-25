import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Claude Code JSONL entry types
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown }
  | { type: string; [key: string]: unknown };

export type ClaudeMessage = {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content?: string | MessageContent[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export type ClaudeEntry = {
  type: string; // 'summary' | 'user' | 'assistant' | 'tool' | ...
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  timestamp?: string; // ISO datetime
  version?: string; // Claude Code version
  message?: ClaudeMessage;
  // Allow other fields
  [key: string]: unknown;
};

/**
 * Async generator: reads a .jsonl file line-by-line, skipping blank/unparseable lines.
 * Never loads the whole file into memory.
 */
export async function* parseSessionFile(filePath: string): AsyncGenerator<ClaudeEntry> {
  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ crlfDelay: Infinity, input: fileStream });

  try {
    for await (const line of rl) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        yield parsed as ClaudeEntry;
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
}
