import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The `run_kind` guard, checked at the altitude it now lives at (P13-012).
 *
 * This test used to count guard fragments against table reads, per table per SQL
 * literal. That was the third version of a counting lint, and the history is the
 * argument for replacing it: the predicate was inline and drifted (org spend read
 * 121 sessions / $547.83 against a true 115 / $19.03); centralizing it into a
 * fragment revealed 18 SQL and 22 ORM sites that had never adopted it; counting
 * per literal then caught seven guards bound to a CTE while the driving query ran
 * unfiltered. Each round found sites the previous round's mechanism could not see,
 * because counting can prove a filter is *present* and never that it is *bound to
 * the right scan*.
 *
 * The filter now lives in two database views, so the question this file asks is
 * much smaller and fully decidable: **does any query in `src/lib` name a base
 * table?** A read of `interactive_sessions` cannot be missing its guard. A read of
 * `sessions` is either a mistake or a documented exception, and saying which is a
 * one-line marker rather than a judgement about join structure.
 *
 * The ORM half is still a counting check, because the client extension that will
 * make it structural is a separate change.
 */

const LIB = join(import.meta.dirname, '../src/lib');

/** A base-table read in raw SQL. The view names do not match — that is the point. */
const BASE_TABLE = /\b(?:FROM|JOIN)\s+(sessions|events)\b(?!_)/g;

/**
 * A read that legitimately sees every run says so within a few lines of itself.
 * Deliberately proximity-based rather than file-level: a file-wide opt-out would
 * exempt every future query someone adds to it.
 */
const EXEMPT = /run-kind-exempt:/;
const EXEMPT_WINDOW = 12;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

function unexemptedBaseTableReads(src: string): string[] {
  const lines = src.split('\n');
  const offenders: string[] = [];
  for (const m of src.matchAll(BASE_TABLE)) {
    const lineNo = src.slice(0, m.index).split('\n').length;
    const from = Math.max(0, lineNo - 1 - EXEMPT_WINDOW);
    const context = lines.slice(from, lineNo).join('\n');
    if (!EXEMPT.test(context)) {
      offenders.push(`line ${lineNo}: ${m[0]}`);
    }
  }
  return offenders;
}

describe('human-facing queries read the filtered views, not the base tables', () => {
  const files = walk(LIB).filter((f) => !f.endsWith('run-kind.ts'));

  it('names no base table without a run-kind-exempt marker beside it', () => {
    const offenders = files.flatMap((f) =>
      unexemptedBaseTableReads(readFileSync(f, 'utf8')).map(
        (o) => `${f.slice(LIB.length + 1)} ${o}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('actually reads the views, so the scan is not passing on an empty codebase', () => {
    const viewReads = files
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
      .match(/\b(?:FROM|JOIN)\s+interactive_(?:sessions|events)\b/g);
    expect(viewReads?.length ?? 0).toBeGreaterThan(50);
  });

  it('scans a plausible number of source files', () => {
    expect(files.length).toBeGreaterThan(20);
  });
});

describe('Prisma ORM reads still carry the explicit guard', () => {
  // Interim: until the client extension lands, an ORM read cannot be routed
  // through a view and must still say `runKind: 'INTERACTIVE'` itself. This is
  // the same counting check as before, kept deliberately narrow — it proves the
  // guarded reads did not lose their guard in the SQL sweep, not that every read
  // is guarded (many legitimately are not).
  const files = walk(LIB);

  it('has not lost the ORM guards', () => {
    const guards = files
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
      .match(/runKind: 'INTERACTIVE'/g);
    expect(guards?.length ?? 0).toBeGreaterThanOrEqual(12);
  });
});
