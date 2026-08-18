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

describe('Prisma ORM reads are guarded by the client, not by call sites', () => {
  const factory = readFileSync(join(LIB, 'prisma.ts'), 'utf8');
  const files = walk(LIB);

  it('applies the extension in getPrisma', () => {
    expect(factory).toMatch(/withInteractiveOnly\(/);
    expect(factory).toMatch(/export function getPrisma/);
    expect(factory).toMatch(/export function getAllRunsPrisma/);
  });

  it('does not cache under the global key packages/db already owns', () => {
    // The bug this pins was silent and total: `packages/db` publishes a
    // module-level singleton on `globalThis._prisma` outside production, so a
    // cache keyed the same way was pre-populated with an **unguarded** client
    // before `getPrisma()` ever ran. Every guarded read then went through the
    // unguarded client, and nothing failed — the extension simply never applied.
    // Harmless while both were the same object; a missing filter the moment one
    // of them carries a guard.
    expect(factory).not.toMatch(/globalForPrisma\._prisma\b/);
  });

  it('makes every unguarded read argue for itself', () => {
    // `getAllRunsPrisma` takes a reason it never uses. The reason is the point:
    // an exemption has to be stated at the call site and shows up in a diff.
    const offenders = files.flatMap((f) => {
      if (f.endsWith('prisma.ts')) {
        return [];
      }
      const src = readFileSync(f, 'utf8');
      const lines = src.split('\n');
      return [...src.matchAll(/getAllRunsPrisma\(/g)].flatMap((m) => {
        const lineNo = src.slice(0, m.index).split('\n').length;
        const context = lines.slice(Math.max(0, lineNo - 1 - EXEMPT_WINDOW), lineNo).join('\n');
        return EXEMPT.test(context) ? [] : [`${f.slice(LIB.length + 1)}:${lineNo}`];
      });
    });

    expect(offenders).toEqual([]);
  });
});
