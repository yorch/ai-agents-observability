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

/**
 * Since P13-012 the alert engine reads `interactive_sessions` / `interactive_events`
 * rather than filtering the base tables, so this counting check is a floor kept for
 * one reason: it proves the SQL sweep did not quietly drop a guard while rewriting
 * the table names. The structural check is the one below it.
 *
 * The alert engine is the one ingest job that is *entirely* a human aggregate —
 * every evaluator answers "is this org's people-driven usage going wrong?", so
 * unlike the sweeps and scorers there is no read in it that should see CI or eval
 * runs. That makes a counting lint meaningful here where it isn't app-wide.
 *
 * It earns its place: the five `sessions` reads were guarded from the start and
 * the two `events` reads were not, so `unknown_model_surge` and `routing_waste`
 * counted machine traffic while `spend_spike` and `budget_threshold` did not.
 * Nothing failed — the numbers were just wrong in one direction.
 *
 * Counting is a floor, not a proof: it cannot tell a filter bound to the scan
 * from one bound to a join. It does prove nobody added a sixth read and forgot.
 */
describe('the alert engine guards every table it scans', () => {
  const source = readFileSync(join(SRC, 'jobs/evaluate-alerts.ts'), 'utf8');
  const count = (re: RegExp) => source.match(re)?.length ?? 0;

  it('reads only the filtered views', () => {
    // Every evaluator here answers "is this org's people-driven usage going
    // wrong?", so there is no read in this file that should see a CI or eval run.
    expect(count(/\bFROM sessions\b(?!_)/g)).toBe(0);
    expect(count(/\bFROM events\b(?!_)/g)).toBe(0);
    expect(count(/\bFROM interactive_sessions\b/g)).toBeGreaterThan(0);
    expect(count(/\bFROM interactive_events\b/g)).toBeGreaterThan(0);
  });

  it('no longer needs the fragment at all', () => {
    // The guard is in the view. A fragment reappearing here would mean someone
    // reverted a table name back to the base table and patched around it.
    expect(count(/interactiveSessions\('s'\)|interactiveEvents\('e'\)/g)).toBe(0);
  });
});

/**
 * The generic half, added when the price-table work (#114) landed a new job —
 * `reprice-events` — that reads and *writes* both base tables, and sailed through
 * this file clean because the only structural check above was hard-scoped to
 * `evaluate-alerts.ts`.
 *
 * That is the same failure the web side already learned: a lint aimed at the
 * places you already thought of cannot see the place you didn't. So this asks the
 * app-wide question instead — any `FROM`/`JOIN`/`UPDATE` naming a base table must
 * say, within a few lines of itself, why it is allowed to see every run.
 *
 * Ingest genuinely has more exempt reads than guarded ones (retention, indexing,
 * redaction backfill, per-session scoring, repricing), which is precisely why the
 * marker has to be written rather than counted: the exemption is the interesting
 * claim here, not the guard.
 */
const BASE_TABLE = /\b(?:FROM|JOIN|UPDATE)\s+(sessions|events)\b(?!_)/g;
const EXEMPT = /run-kind-exempt:/;
const EXEMPT_WINDOW = 12;

describe('every base-table read in ingest states why it sees all runs', () => {
  it('names no base table without a run-kind-exempt marker beside it', () => {
    // run-kind.ts is the filter's own definition — it names the base tables
    // because it is the thing that filters them.
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith('lib/run-kind.ts'))
      .flatMap((file) => {
        const src = readFileSync(file, 'utf8');
        const lines = src.split('\n');
        return [...src.matchAll(BASE_TABLE)]
          .map((m) => {
            const lineNo = src.slice(0, m.index).split('\n').length;
            const context = lines.slice(Math.max(0, lineNo - 1 - EXEMPT_WINDOW), lineNo).join('\n');
            return EXEMPT.test(context)
              ? null
              : `${file.slice(SRC.length + 1)} line ${lineNo}: ${m[0]}`;
          })
          .filter((o): o is string => o !== null);
      });

    expect(offenders).toEqual([]);
  });
});
