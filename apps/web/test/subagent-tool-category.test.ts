import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for the bug fixed in P14-001.
 *
 * `getOrgSubagentStats` / `getTeamSubagentStats` filtered `tool_category = 'agent'`
 * to find sub-agent spawn events, and `getToolStats` / `getToolCategoryBreakdown`
 * filtered `tool_category != 'agent'` to exclude them from the tool tables. No
 * adapter has ever emitted `'agent'` — every producer writes only `'mcp'` or
 * `'builtin'` — so both filters were dead on arrival: the sub-agent panels always
 * rendered empty, and (because `NULL != 'agent'` is NULL, which `WHERE` treats as
 * false) the exclusion silently dropped every NULL-category row from the tool
 * tables too.
 *
 * The class of bug, not just this one string: a web query compares
 * `tool_category` against a literal value no adapter can actually produce. This
 * derives the emittable set from the adapter source itself — not a
 * hand-maintained constant that could drift out of sync the same way the buggy
 * filter did — and asserts no literal `=`/`!=` comparison in the two fixed query
 * modules names a value outside it.
 *
 * Deliberately out of scope: the fine-grained tool-category taxonomy
 * (`fs_read`/`fs_write`/`exec`/`web`/`search`, used by security-queries.ts,
 * routing-queries.ts, and model-policy) genuinely is not emitted by any adapter
 * yet — that gap is P14-002's mandate, in progress in parallel, and this test
 * does not scan those files or assert on that taxonomy.
 */

const HOOK_SRC = join(import.meta.dirname, '../../hook/src');
const WEB_LIB = join(import.meta.dirname, '../src/lib');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Every string literal an adapter source file assigns to a tool event's
 * `category` field, found by scanning lines that mention `category` for quoted
 * string literals — robust to whether the assignment is a direct literal
 * (`category: 'builtin'`) or a ternary (`category: isMcp ? 'mcp' : 'builtin'`).
 */
function emittableToolCategories(): Set<string> {
  const files = walk(HOOK_SRC).filter((f) => !f.endsWith('.test.ts'));
  const values = new Set<string>();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!/\bcategory\b/.test(line)) {
        continue;
      }
      for (const m of line.matchAll(/'([a-z_]+)'/g)) {
        values.add(m[1] as string);
      }
    }
  }
  return values;
}

/** Literal `tool_category = '...'` / `!= '...'` comparisons found in source. */
function categoryLiteralComparisons(src: string): string[] {
  return [...src.matchAll(/tool_category\s*(?:!=|=)\s*'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe('the sub-agent queries only filter tool_category on values adapters can emit', () => {
  const emittable = emittableToolCategories();

  it('scans a non-empty, plausible set (the scan itself is not vacuous)', () => {
    expect(emittable).toEqual(new Set(['builtin', 'mcp']));
  });

  it('confirms no adapter emits the category this bug filtered on', () => {
    expect(emittable.has('agent')).toBe(false);
  });

  for (const file of ['org-queries.ts', 'team-queries.ts']) {
    it(`${file} names no tool_category literal outside the emittable set`, () => {
      const src = readFileSync(join(WEB_LIB, file), 'utf8');
      const offenders = categoryLiteralComparisons(src).filter((v) => !emittable.has(v));
      expect(offenders).toEqual([]);
    });
  }
});

describe('sub-agent spawns are identified by subagent_type, not tool_category', () => {
  for (const [file, fn] of [
    ['org-queries.ts', 'getOrgSubagentStats'],
    ['team-queries.ts', 'getTeamSubagentStats'],
  ] as const) {
    it(`${fn} (${file}) filters on subagent_type IS NOT NULL`, () => {
      const src = readFileSync(join(WEB_LIB, file), 'utf8');
      const start = src.indexOf(`function ${fn}`);
      expect(start).toBeGreaterThan(-1);
      const nextFn = src.indexOf('\nexport ', start + 1);
      const body = src.slice(start, nextFn === -1 ? undefined : nextFn);
      expect(body).toMatch(/subagent_type\s+IS\s+NOT\s+NULL/);
    });
  }
});
