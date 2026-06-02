import { gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { redact } from '@ai-agents-observability/redaction';

export type PipelineResult = {
  outputBytes: number;
  recompressed: Uint8Array;
  redactionFlags: string[];
};

/**
 * Hard cap on the DECOMPRESSED transcript size. The route caps the compressed
 * body, but a highly-compressible zstd/gzip payload (a "zip bomb") can expand
 * by orders of magnitude and OOM the single-threaded process. 512 MiB is well
 * above any realistic transcript; beyond this we should stream, not buffer.
 */
export const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

/** Thrown when a transcript decompresses past {@link MAX_DECOMPRESSED_BYTES}. */
export class TranscriptTooLargeError extends Error {
  constructor() {
    super('Transcript exceeds maximum decompressed size');
    this.name = 'TranscriptTooLargeError';
  }
}

// Decompress → split JSONL → redact each line → recompress as zstd.
// Accepts zstd (server-to-server) or gzip (hook client, pending native Bun zstd).
// Memory-bounded by `maxOutputLength` so a decompression bomb can't OOM the
// process. v1 keeps the whole transcript in memory because single-PUT to MinIO
// is simpler than streaming multipart; switch to a streaming pipeline
// (`createZstdDecompress` + `node:readline`) if real sessions approach the cap.
export function processTranscript(
  compressed: Uint8Array,
  contentType?: string,
  maxDecompressedBytes: number = MAX_DECOMPRESSED_BYTES,
): PipelineResult {
  let decompressed: Buffer;
  try {
    decompressed =
      contentType === 'application/gzip'
        ? gunzipSync(compressed, { maxOutputLength: maxDecompressedBytes })
        : zstdDecompressSync(compressed, { maxOutputLength: maxDecompressedBytes });
  } catch (err) {
    // node:zlib throws RangeError ERR_BUFFER_TOO_LARGE when maxOutputLength is hit.
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new TranscriptTooLargeError();
    }
    throw err;
  }

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
