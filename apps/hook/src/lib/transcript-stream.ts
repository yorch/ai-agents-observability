import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

import { redact } from '@ai-agents-observability/redaction';

/**
 * Reads a JSONL file line by line, redacts each line, yields redacted lines.
 */
export async function* redactedLines(filePath: string): AsyncGenerator<string> {
  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const { text } = redact(line);
    yield text;
  }
}

/**
 * Returns SHA-256 hex of the full redacted content (all lines joined with newlines).
 */
export async function contentHash(lines: AsyncIterable<string>): Promise<string> {
  const hash = createHash('sha256');
  let first = true;
  for await (const line of lines) {
    if (!first) hash.update('\n');
    hash.update(line);
    first = false;
  }
  return hash.digest('hex');
}
