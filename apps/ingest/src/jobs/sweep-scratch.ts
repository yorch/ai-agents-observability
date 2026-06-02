import { readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';

// Must match the scratch-file naming in routes/transcripts.ts `chunkPath()`.
// Chunked uploads write a `.part` scratch file; an abandoned upload (client
// uploads chunk 0 then disappears) would otherwise leave it in tmp forever.
const SCRATCH_PREFIX = 'claude-telemetry-transcript-';
const SCRATCH_SUFFIX = '.zst.part';
const MAX_AGE_MS = 6 * 60 * 60 * 1_000; // 6h — far beyond any legitimate upload

export async function runSweepScratch(
  logger?: Logger,
  now: number = Date.now(),
  dir: string = tmpdir(),
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(SCRATCH_PREFIX) || !name.endsWith(SCRATCH_SUFFIX)) {
      continue;
    }
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (now - s.mtimeMs > MAX_AGE_MS) {
        await unlink(p);
        removed++;
      }
    } catch {
      // Racing cleanup or permission error — skip; next sweep retries.
    }
  }

  if (removed > 0) {
    logger?.info({ removed }, 'sweep-scratch: removed stale transcript scratch files');
  }
  return removed;
}
