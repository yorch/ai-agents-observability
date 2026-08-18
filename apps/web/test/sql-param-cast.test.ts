import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Postgres overload resolution needs a type on a bound parameter that reaches a
 * polymorphic function, and Prisma binds every `${}` as an untyped parameter.
 *
 * `date_trunc` is the one that bit us. It has three overloads — `(text,
 * timestamp)`, `(text, timestamptz)` and `(text, interval)` — and in a prepared
 * statement a bare `'day'` literal is also `unknown`, so
 * `date_trunc('day', ${since})` arrives as `date_trunc(unknown, unknown)` and
 * Postgres refuses it with `42725: function date_trunc(unknown, unknown) is not
 * unique`.
 *
 * Five org-rollup functions shipped this way — `getCostByTeam`,
 * `getOrgModelDetail`, `getWeeklyCostTrend`, `getOrgTopTools` and
 * `getCostPerDeveloper`. **Every one of them threw on every call**, which is the
 * interesting part: they are wrapped in per-card error boundaries, so five org
 * dashboard panels rendered an error state that nobody read as a bug, and no
 * test caught it because the tests mock Prisma and never send SQL to a server.
 *
 * That is why this is a source scan rather than a unit test. A test with a mock
 * database cannot fail on a query the database would reject — only a real
 * connection or the text of the query itself can tell you. This checks the text.
 */

const SRC = join(import.meta.dirname, '../src/lib');

/**
 * A `date_trunc` whose second argument is an interpolation. Matches
 * `date_trunc('day', ${x})` and rejects it unless a `::type` cast follows the
 * closing brace.
 */
const UNCAST_DATE_TRUNC = /date_trunc\(\s*'[a-z]+'\s*,\s*\$\{[^}]*\}(?!\s*::)/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('bound parameters reaching a polymorphic function carry a cast', () => {
  const files = walk(SRC);

  it('has no uncast interpolation inside date_trunc', () => {
    const offenders = files.flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(UNCAST_DATE_TRUNC)].map((m) => {
        const line = src.slice(0, m.index).split('\n').length;
        return `${f.slice(SRC.length + 1)}:${line} — ${m[0].trim()}`;
      });
    });

    expect(offenders).toEqual([]);
  });

  it('actually scans a plausible number of source files', () => {
    // Guards against the scan passing because it found nothing to read.
    expect(files.length).toBeGreaterThan(20);
  });
});
