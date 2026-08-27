import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { addNullable, sumAttributed } from '../src/lib/attribution-coverage';

/**
 * The web half of P14-004.
 *
 * Two properties matter here and neither is checkable by rendering a page:
 *
 * 1. **The two columns are never added.** `attributed_cost_usd` and
 *    `downstream_cost_usd` are two readings of the same dollars — turn N+1's
 *    cost is both its own tools' issuing share and the previous turn's tools'
 *    downstream inflation. A `SUM(a + b)` or an `a + b` in a component is a
 *    double count that would look entirely plausible on screen. So the lint asks
 *    the question directly, over the whole query layer and every surface.
 *
 * 2. **Nothing ever renders a NULL attribution as $0.00.** NULL means "no turn
 *    linkage on these events", which is a gap in capture, not a measurement. The
 *    query layer keeps it NULL (no `COALESCE(SUM(attributed_cost_usd), 0)`), and
 *    the two aggregation helpers keep it NULL through arithmetic.
 *
 * Both are exactly the shape of mistake this whole phase exists to remove: a
 * number that reads as a fact and is not one.
 */

const LIB = join(import.meta.dirname, '../src/lib');
const APP = join(import.meta.dirname, '../src/app');
const COMPONENTS = join(import.meta.dirname, '../src/components');

const ATTR = 'attributed_cost_usd';
const DOWN = 'downstream_cost_usd';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return walk(full);
    }
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
  });
}

const ALL_SOURCES = [...walk(LIB), ...walk(APP), ...walk(COMPONENTS)];

describe('the two attributions are never summed together', () => {
  it('no SQL expression adds the two columns', () => {
    // Catches `SUM(attributed_cost_usd + downstream_cost_usd)` and any
    // `a + b` / `b + a` in a projection, in either order.
    const bothWays = [
      new RegExp(`${ATTR}\\s*\\+\\s*${DOWN}`),
      new RegExp(`${DOWN}\\s*\\+\\s*${ATTR}`),
    ];
    const offenders = ALL_SOURCES.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return bothWays.some((re) => re.test(src));
    });

    expect(offenders).toEqual([]);
  });

  it('no TypeScript expression adds the two fields', () => {
    const bothWays = [
      /attributedCostUsd\s*\??\s*\+\s*[\w.?]*downstreamCostUsd/,
      /downstreamCostUsd\s*\??\s*\+\s*[\w.?]*attributedCostUsd/,
    ];
    const offenders = ALL_SOURCES.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return bothWays.some((re) => re.test(src));
    });

    expect(offenders).toEqual([]);
  });

  it('actually scans a plausible number of files', () => {
    // Guards against the two checks above passing because the walk found nothing.
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
    expect(
      ALL_SOURCES.filter((f) => readFileSync(f, 'utf8').includes(ATTR)).length,
    ).toBeGreaterThan(2);
  });
});

describe('a missing attribution stays missing', () => {
  it('never collapses a NULL sum to zero in SQL', () => {
    // `COALESCE(SUM(attributed_cost_usd), 0)` would turn "no turn linkage" into
    // "$0.00 of cost" — the precise fiction these columns replaced.
    const coalesced = new RegExp(`COALESCE\\s*\\(\\s*SUM\\s*\\(\\s*(?:${ATTR}|${DOWN})`, 'i');
    const offenders = ALL_SOURCES.filter((f) => coalesced.test(readFileSync(f, 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('sumAttributed returns null when nothing is attributed', () => {
    expect(sumAttributed([])).toBeNull();
    expect(sumAttributed([null, null])).toBeNull();
  });

  it('sumAttributed totals the values that do exist', () => {
    // A partial window is a lower bound, not a hole — the coverage line beside
    // it is what tells the reader how partial.
    expect(sumAttributed([0.25, null, 0.75])).toBe(1);
    expect(sumAttributed([0])).toBe(0);
  });

  it('addNullable treats null as absent rather than as zero', () => {
    expect(addNullable(null, null)).toBeNull();
    expect(addNullable(null, 2)).toBe(2);
    expect(addNullable(2, null)).toBe(2);
    expect(addNullable(1.5, 2.5)).toBe(4);
  });
});

describe('the attributed queries keep the visibility and run-kind guards', () => {
  // `attribution-coverage.ts` is checked separately below: it deliberately
  // mentions neither column (it measures linkage, not cost), so it contributes
  // no "attributed SQL block" to scan.
  const QUERY_FILES = [
    join(LIB, 'org-queries.ts'),
    join(LIB, 'team-queries.ts'),
    join(LIB, 'insights-queries.ts'),
  ];

  /**
   * Every SQL template literal in a file that mentions either attribution
   * column. Cost is per-user data, so a new column must not become the reason a
   * lead sees through a member's privacy setting.
   */
  function attributedSqlBlocks(file: string): string[] {
    const src = readFileSync(file, 'utf8');
    return [...src.matchAll(/Prisma\.sql`([\s\S]*?)`\s*\)/g)]
      .map((m) => m[1] as string)
      .filter((sql) => sql.includes(ATTR) || sql.includes(DOWN));
  }

  it('reads only the filtered view, never the base table', () => {
    // `FROM` or `JOIN`: the routing-by-team read (P14-005) drives off `teams`
    // and reaches the hypertable through two joins, so requiring the view in
    // the FROM clause alone would reject a correctly-guarded query.
    for (const file of QUERY_FILES) {
      for (const sql of attributedSqlBlocks(file)) {
        expect(sql).toMatch(/(?:FROM|JOIN)\s+interactive_events/);
        expect(sql).not.toMatch(/\b(?:FROM|JOIN)\s+events\b/);
      }
    }
  });

  it('scopes the coverage read to an explicit user set too', () => {
    const src = readFileSync(join(LIB, 'attribution-coverage.ts'), 'utf8');

    expect(src).toMatch(/FROM\s+interactive_events/);
    expect(src).toMatch(/user_id\s+IN\s*\(/);
  });

  it('scopes every attributed read to an explicit user set', () => {
    // Three admissible forms, and no fourth:
    //   `user_id IN (${uuids})`        org/team surfaces — the caller passed the
    //                                  population from orgVisibleUserIds /
    //                                  resolveTeamVisibility.
    //   `user_id = ${userId}`          own-data surfaces.
    //   a `visibility_policies` join   `getRoutingSpendByTeam` (P14-005), which
    //                                  builds its own population by walking
    //                                  teams → members → users and applies
    //                                  `share_metadata_with_org` in the query.
    // Cost is per-user data; a new column must never become the reason a lead
    // sees through a member's privacy setting.
    const byUserList = /user_id\s+IN\s*\(|user_id\s*=\s*\$\{userId\}/;
    const byPolicyJoin = /visibility_policies/;
    for (const file of QUERY_FILES) {
      const blocks = attributedSqlBlocks(file);
      expect(blocks.length).toBeGreaterThan(0);
      for (const sql of blocks) {
        const scoped = byUserList.test(sql) || byPolicyJoin.test(sql);
        expect(scoped, sql).toBe(true);
        if (byPolicyJoin.test(sql)) {
          expect(sql).toMatch(/share_metadata_with_org/);
        }
      }
    }
  });
});

describe('coverage is measured, not assumed', () => {
  it('derives coverage from turn_number rather than from the cost columns', () => {
    // Counting sessions with a non-null cost would report 0% for a window whose
    // turns simply issued no tools — a different thing entirely from "this agent
    // does not report linkage".
    const src = readFileSync(join(LIB, 'attribution-coverage.ts'), 'utf8');

    expect(src).toMatch(/FILTER\s*\(\s*WHERE\s+turn_number\s+IS\s+NOT\s+NULL\s*\)/);
    expect(src).not.toContain(ATTR);
  });

  it('is rendered on every surface that shows an attributed figure', () => {
    // A page that prints one of these numbers without the caption leaves the
    // reader with no way to tell a real $0 from an uncaptured one.
    const surfaces = walk(APP).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes('attributedCostUsd') || src.includes('downstreamCostUsd');
    });

    expect(surfaces.length).toBeGreaterThan(0);
    for (const file of surfaces) {
      expect(readFileSync(file, 'utf8')).toContain('CostAttributionNote');
    }
  });
});
