import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Ingest-side companion to `apps/web/test/run-kind-coverage.test.ts`.
 *
 * The web lint only scans `apps/web/src/lib`, so the ingest jobs had the same
 * predicate spelled inline nine times with nothing enforcing it. That is exactly
 * the shape that let CI runs into org spend on the web side: a filter that lives
 * as a string in N places drifts, and the drift is invisible.
 *
 * This is the cheap half of the same discipline — it does not try to prove every
 * query is guarded (the ingest jobs deliberately differ: retention, indexing and
 * effectiveness scoring must see every session). It proves only that where the
 * filter IS applied, it comes from the one shared module, so a reader can find
 * every use by following the import.
 */

const SRC = join(import.meta.dirname, '../src');

/** The fragment's own definition, and the write path that merges the column. */
const ALLOWED = new Set(['run-kind.ts', 'upsert-session.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('run_kind filtering goes through the shared fragment', () => {
  const files = walk(SRC);

  it('has no inline run_kind read filter outside the fragment module', () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f.split('/').pop() ?? ''))
      .filter((f) => /run_kind\s*=\s*'INTERACTIVE'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it('actually scans a plausible number of source files', () => {
    // Guards against the scan silently passing because it found nothing to read.
    expect(files.length).toBeGreaterThan(20);
  });
});
