import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source-level invariant for P13-002.
 *
 * Every human-facing read of `sessions` must filter to INTERACTIVE runs. Applying
 * that by hand across ~50 query sites and trusting review is exactly how one gets
 * missed — and a missed site fails silently, letting CI/eval runs into a
 * per-developer aggregate with no test going red.
 *
 * So the invariant is checked against the source itself. Two scanners run:
 *
 * 1. **SQL literals.** Every `FROM`/`JOIN` of `sessions` or `events` inside a
 *    template literal in `src/lib` must be *accounted for*. Accounting is by
 *    count, per table, within the literal: N reads of `sessions` need N
 *    references to `INTERACTIVE_ONLY` / `interactiveOnly(...)`, and N reads of
 *    `events` need N references to `INTERACTIVE_EVENTS` / `interactiveEvents(...)`.
 *    Any shortfall must be covered one-for-one by a `run-kind-exempt: <reason>`
 *    marker in that same literal.
 *
 *    The earlier version of this lint asked only whether a guard appeared
 *    *somewhere* in the literal. That is far too weak for the shape of query this
 *    codebase writes: a multi-CTE literal that scans `events` three times and
 *    guards one of them passed clean, which is exactly how the cohort-friction
 *    outer scan, both MCP `server_users` CTEs, both skill adoption funnels and
 *    three `getSkillUsage` variants all shipped with a mixed population.
 *
 * 2. **Prisma ORM calls.** `prisma.session.findMany/count/aggregate/groupBy/...`
 *    never appears inside a SQL literal, so the literal scanner cannot see it —
 *    and the session *list* was reachable by a CI run for exactly that reason.
 *    Each ORM read of `session`/`event` must have `runKind` mentioned somewhere in
 *    its enclosing function, or carry a `run-kind-exempt:` marker there.
 *
 * This is still a lint, not a behavioural test. Counting cannot prove a guard is
 * bound to the *right* one of two reads of the same table — only that no read went
 * unconsidered. That is the property worth having automatically; correctness of
 * placement is what review and the seeded CI/EVAL fixtures are for.
 */

const LIB_DIR = join(import.meta.dirname, '../src/lib');

const EXEMPT_PATTERN = /run-kind-exempt:/g;
// `sessions_with_skill` and similar CTE names must not count as a sessions read,
// hence the `(?!_)`. `events` carries its own denormalized run_kind and is queried
// without a sessions join on most read paths, so it needs the same guard.
const SESSION_READ = /\b(?:FROM|JOIN)\s+sessions\b(?!_)/g;
const EVENT_READ = /\b(?:FROM|JOIN)\s+events\b(?!_)/g;
const SESSION_GUARD = /INTERACTIVE_ONLY|interactiveOnly\(/g;
const EVENT_GUARD = /INTERACTIVE_EVENTS|interactiveEvents\(/g;

// Prisma ORM reads of the two run_kind-bearing models. `updateMany`/`deleteMany`
// are mechanical row operations (retention, deletion) and are deliberately not
// listed — run_kind is about who a metric is *about*, not which rows exist.
const ORM_CALL =
  /(?:prisma|getPrisma\(\))\.(?:session|event)\.(?:findMany|findFirst|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/g;
const FUNCTION_START = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+\w+/g;
const ORM_GUARD = /runKind/;

function countMatches(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
}

function sqlLiterals(source: string): string[] {
  // Template literals are delimited by backticks; odd-indexed chunks are literal
  // bodies. Interpolations are included in the body text, which is what lets the
  // guard reference be seen.
  const chunks = source.split('`');
  return chunks.filter((_, i) => i % 2 === 1);
}

/**
 * Source span from the start of the function enclosing `callIndex` through the end
 * of the ORM call's argument list. The `where` an ORM call uses is very often built
 * a few lines above it (`const where: Prisma.SessionWhereInput = { … }`), so the
 * call's own arguments are not a wide enough window to judge it by.
 */
function ormCallRegion(source: string, callIndex: number, argsOpenIndex: number): string {
  let fnStart = 0;
  FUNCTION_START.lastIndex = 0;
  for (const m of source.matchAll(FUNCTION_START)) {
    if (m.index !== undefined && m.index < callIndex) {
      fnStart = m.index;
    }
  }

  // A function's doc comment is part of how it justifies itself, so include it —
  // that is where a `run-kind-exempt:` reason naturally gets written.
  const before = source.slice(0, fnStart).trimEnd();
  if (before.endsWith('*/')) {
    const docStart = before.lastIndexOf('/**');
    if (docStart !== -1) {
      fnStart = docStart;
    }
  }

  let depth = 0;
  let end = source.length;
  for (let i = argsOpenIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  // Strip template-literal bodies. A function that mixes a raw SQL query with ORM
  // calls would otherwise have its ORM calls exempted by a `run-kind-exempt:`
  // marker that was written about the SQL — the two scanners must not cover for
  // each other.
  return source
    .slice(fnStart, end)
    .split('`')
    .filter((_, i) => i % 2 === 0)
    .join(' ');
}

// run-kind.ts defines the guard itself; its doc comment names the patterns it
// exists to match, so scanning it would report the definition as a violation.
const SCAN_EXCLUDE = new Set(['run-kind.ts']);

function tsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !SCAN_EXCLUDE.has(f))
    .map((f) => join(dir, f));
}

function firstLineOf(text: string): string {
  return (text.trim().split('\n')[0]?.trim() ?? '').slice(0, 90);
}

function sqlOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of tsFiles(LIB_DIR)) {
    const name = file.split('/').pop();
    const source = readFileSync(file, 'utf8');
    for (const literal of sqlLiterals(source)) {
      const sessionReads = countMatches(literal, SESSION_READ);
      const eventReads = countMatches(literal, EVENT_READ);
      if (sessionReads + eventReads === 0) {
        continue;
      }
      const sessionShort = Math.max(0, sessionReads - countMatches(literal, SESSION_GUARD));
      const eventShort = Math.max(0, eventReads - countMatches(literal, EVENT_GUARD));
      const shortfall = sessionShort + eventShort - countMatches(literal, EXEMPT_PATTERN);
      if (shortfall > 0) {
        offenders.push(
          `${name}: ${shortfall} unaccounted read(s) ` +
            `(sessions ${sessionReads}, events ${eventReads}) — ${firstLineOf(literal)}`,
        );
      }
    }
  }
  return offenders;
}

function ormOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of tsFiles(LIB_DIR)) {
    const name = file.split('/').pop();
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(ORM_CALL)) {
      if (m.index === undefined) {
        continue;
      }
      const region = ormCallRegion(source, m.index, m.index + m[0].length - 1);
      if (ORM_GUARD.test(region) || /run-kind-exempt:/.test(region)) {
        continue;
      }
      const line = source.slice(0, m.index).split('\n').length;
      offenders.push(`${name}:${line}: ${m[0]}`);
    }
  }
  return offenders;
}

describe('run_kind coverage', () => {
  it('accounts for every SQL read of sessions or events', () => {
    expect(sqlOffenders()).toEqual([]);
  });

  it('accounts for every Prisma ORM read of session or event', () => {
    expect(ormOffenders()).toEqual([]);
  });

  it('finds session queries at all (guards against the scanner silently matching nothing)', () => {
    // If a refactor moves the query layer, this test must fail loudly rather than
    // pass by scanning an empty set and reporting success.
    const literals = tsFiles(LIB_DIR).flatMap((f) => sqlLiterals(readFileSync(f, 'utf8')));
    const totalReads = literals.reduce(
      (n, l) => n + countMatches(l, SESSION_READ) + countMatches(l, EVENT_READ),
      0,
    );
    expect(totalReads).toBeGreaterThan(40);

    const totalOrmCalls = tsFiles(LIB_DIR).reduce(
      (n, f) => n + countMatches(readFileSync(f, 'utf8'), ORM_CALL),
      0,
    );
    expect(totalOrmCalls).toBeGreaterThan(10);
  });
});
