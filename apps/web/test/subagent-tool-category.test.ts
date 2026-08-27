import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOOL_CATEGORIES } from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for the bug fixed in P14-001.
 *
 * `getOrgSubagentStats` / `getTeamSubagentStats` filtered `tool_category = 'agent'`
 * to find sub-agent spawn events, and `getToolStats` / `getToolCategoryBreakdown`
 * filtered `tool_category != 'agent'` to exclude them from the tool tables. No
 * producer has ever emitted `'agent'`, so both filters were dead on arrival: the
 * sub-agent panels always rendered empty, and (because `NULL != 'agent'` is NULL,
 * which `WHERE` treats as false) the exclusion silently dropped every
 * NULL-category row from the tool tables too.
 *
 * The class of bug, not just this one string: a web query compares
 * `tool_category` against a literal value no producer can actually emit.
 *
 * **This test originally derived the emittable set by scanning the adapter
 * sources for quoted literals**, because at the time the taxonomy existed only
 * as scattered `category: 'builtin'` assignments — there was nothing to import.
 * P14-002 replaced those literals with a single `toolCategory()` function, which
 * left the scan matching nothing. It failed loudly rather than passing over an
 * empty set, which is what the anti-vacuity assertion below exists for, and is
 * why the scan is now a direct import: `TOOL_CATEGORIES` is the one place the
 * taxonomy is spelled out in code, and `packages/schemas/src/tool-category.test.ts`
 * pins it against `DESIGN_DOC.md` §5.3. Importing it is strictly stronger than
 * scanning for it — it cannot silently go empty.
 */

const WEB_LIB = join(import.meta.dirname, '../src/lib');

/** Literal `tool_category = '...'` / `!= '...'` comparisons found in source. */
function categoryLiteralComparisons(src: string): string[] {
  return [...src.matchAll(/tool_category\s*(?:!=|=)\s*'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe('the sub-agent queries only filter tool_category on values producers can emit', () => {
  const emittable = new Set<string>(TOOL_CATEGORIES);

  it('reads a non-empty, plausible set (the source of truth is not vacuous)', () => {
    expect(emittable).toEqual(
      new Set(['fs_read', 'fs_write', 'exec', 'search', 'web', 'task', 'mcp', 'other']),
    );
  });

  it('confirms no producer emits the category this bug filtered on', () => {
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
