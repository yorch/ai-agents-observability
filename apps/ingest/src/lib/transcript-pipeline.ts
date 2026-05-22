import { gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { redact } from '@ai-agents-observability/redaction';

export type PipelineResult = {
  outputBytes: number;
  recompressed: Uint8Array;
  redactionFlags: string[];
};

// Decompress → split JSONL → redact each line → recompress as zstd.
// Accepts zstd (server-to-server) or gzip (hook client, pending native Bun zstd).
// Memory-bounded by compression ratio; v1 keeps the whole transcript in memory because
// single-PUT to MinIO is simpler than streaming multipart and the practical
// upper bound (a few hundred MB compressed) fits today's developer machines.
// Switch to a streaming pipeline (`createZstdDecompress` + `node:readline`)
// if real sessions exceed ~200 MB compressed.
export function processTranscript(compressed: Uint8Array, contentType?: string): PipelineResult {
  const decompressed =
    contentType === 'application/gzip' ? gunzipSync(compressed) : zstdDecompressSync(compressed);

  const text = new TextDecoder('utf-8').decode(decompressed);

  const flagSet = new Set<string>();
  const redactedLines: string[] = [];

  // Preserve trailing newline behavior so re-uploads are byte-identical.
  const trailingNewline = text.endsWith('\n');
  const lines = trailingNewline ? text.slice(0, -1).split('\n') : text.split('\n');

  for (const line of lines) {
    if (line.length === 0) {
      redactedLines.push('');
      continue;
    }
    const { flags, text: redacted } = redact(line);
    redactedLines.push(redacted);
    for (const f of flags) {
      flagSet.add(f);
    }
  }

  const out = redactedLines.join('\n') + (trailingNewline ? '\n' : '');
  const outBytes = new TextEncoder().encode(out);
  const recompressed = new Uint8Array(zstdCompressSync(outBytes));

  return {
    outputBytes: recompressed.byteLength,
    recompressed,
    redactionFlags: [...flagSet].sort(),
  };
}
