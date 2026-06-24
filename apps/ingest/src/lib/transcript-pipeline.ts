import { promisify } from 'node:util';
import { gunzip, zstdCompress, zstdDecompress } from 'node:zlib';

import { redact } from '@ai-agents-observability/redaction';

const gunzipAsync = promisify(gunzip);
const zstdDecompressAsync = promisify(zstdDecompress);
const zstdCompressAsync = promisify(zstdCompress);

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
//
// All zlib ops run on the libuv threadpool (async variants) so they don't block
// the single-threaded Bun.serve event loop during compress/decompress.
export async function processTranscript(
  compressed: Uint8Array,
  contentType?: string,
  maxDecompressedBytes: number = MAX_DECOMPRESSED_BYTES,
): Promise<PipelineResult> {
  let decompressed: Buffer;
  try {
    decompressed =
      contentType === 'application/gzip'
        ? await gunzipAsync(compressed, { maxOutputLength: maxDecompressedBytes })
        : await zstdDecompressAsync(compressed, { maxOutputLength: maxDecompressedBytes });
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

  // Process lines with a cooperative yield every 2000 lines so the CPU-bound
  // redaction loop cannot starve other event-loop tasks (e.g. /v1/events).
  // setImmediate is used rather than Promise.resolve() because it places the
  // continuation after I/O callbacks in Bun's event loop, giving pending network
  // handlers a chance to run.
  const YIELD_INTERVAL = 2000;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % YIELD_INTERVAL === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    const line = lines[i] as string;
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
  const recompressed = new Uint8Array(await zstdCompressAsync(outBytes));

  return {
    outputBytes: recompressed.byteLength,
    recompressed,
    redactionFlags: [...flagSet].sort(),
  };
}
