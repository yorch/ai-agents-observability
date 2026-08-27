import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The seed is now a second writer of `events.attributed_cost_usd` and
 * `events.downstream_cost_usd` (P14-011), and it inherits every guard the job
 * carries.
 *
 * ── Why this is a test and not a convention ──────────────────────────────────
 *
 * A seed that reimplements production is the defect Phase 14 exists to remove.
 * The fabricated per-tool cost, the invented `tool_category` taxonomy and the
 * `model`-on-tool-rows fiction each passed review because every query was
 * written against seeded data that agreed with nothing a producer emits. So the
 * attribution arithmetic lives once, in
 * `packages/schemas/src/cost-attribution.ts`, and the seed *calls* it. That is
 * only true for as long as nobody "simplifies" it back into a SQL expression
 * here, which is what this file is for.
 *
 * The other properties are the P14-004 invariants, restated against the new
 * writer because a second writer is exactly where an invariant gets lost:
 *
 * 1. The two columns are **two lenses on the same dollars, not two costs** —
 *    turn N+1's cost appears once as its own tools' issuing share and again as
 *    the previous turn's tools' downstream inflation. Summing them double-counts.
 * 2. Neither may re-enter the `events.cost_usd` → `sessions.total_cost_usd` →
 *    `pr_rollups.total_cost_usd` → cost-cagg chain, which already counts these
 *    dollars exactly once. `apps/ingest/test/compute-cost-attribution.test.ts`
 *    asserts that for the job by inspecting the statements it issues; the seed's
 *    statement is a literal in the source, so it is asserted here directly.
 * 3. NULL means *not attributed*, never $0.00.
 *
 * The anti-vacuity assertions matter as much as the rules: this shape of test
 * dies by finding nothing and passing.
 */

const SEED = readFileSync(join(import.meta.dirname, '../src/seed.ts'), 'utf8');

const ATTR = 'attributed_cost_usd';
const DOWN = 'downstream_cost_usd';

/** The SQL template literals in the seed that assign either attribution column. */
function attributionWriteStatements(): string[] {
  const statements: string[] = [];
  const re = /\$executeRaw(?:Unsafe)?\(?\s*(?:Prisma\.sql)?`([\s\S]*?)`/g;
  for (const m of SEED.matchAll(re)) {
    const sql = m[1] ?? '';
    if (new RegExp(`SET[\\s\\S]*\\b(?:${ATTR}|${DOWN})\\b`).test(sql)) {
      statements.push(sql);
    }
  }
  return statements;
}

describe('the seed gets its attribution from the shared definition', () => {
  it('calls computeSessionAttribution from packages/schemas', () => {
    // The whole point of P14-011. If this import goes, the seed has started
    // reimplementing production again.
    const schemasImport = SEED.match(
      /import\s*\{([\s\S]*?)\}\s*from\s*'@ai-agents-observability\/schemas';/,
    );
    expect(schemasImport?.[1]).toContain('computeSessionAttribution');
    expect(SEED).toMatch(/computeSessionAttribution\(events, seedPriceFor\)/);
  });

  it('never derives either column from a SQL expression', () => {
    // A `SET attributed_cost_usd = cost_usd / n` here would be a second,
    // undocumented definition of a number the product prints with a dollar sign.
    // Every write must take its value from a bound parameter.
    const statements = attributionWriteStatements();
    expect(statements.length).toBeGreaterThan(0); // anti-vacuity
    for (const sql of statements) {
      // Strike out the one assignment form that is allowed — both columns taken
      // straight from the bound VALUES row — and nothing that assigns either
      // column may be left.
      const stripped = sql.replace(
        /SET\s+attributed_cost_usd = v\.attributed,\s+downstream_cost_usd = v\.downstream/,
        'SET <bound values>',
      );
      expect(stripped).toContain('SET <bound values>');
      expect(stripped).not.toMatch(/attributed_cost_usd\s*=/);
      expect(stripped).not.toMatch(/downstream_cost_usd\s*=/);
      // And no reference to the inputs the shared definition consumes.
      expect(sql).not.toMatch(/input_tokens|cache_read_tokens|cache_creation_tokens/);
    }
  });
});

describe('the seed keeps the P14-004 invariants', () => {
  it('never lets an attribution write touch the session / PR / cagg cost chain', () => {
    const statements = attributionWriteStatements();
    expect(statements.length).toBeGreaterThan(0); // anti-vacuity
    for (const sql of statements) {
      expect(sql).toMatch(/UPDATE\s+events\s+e/);
      expect(sql).not.toMatch(/total_cost_usd/);
      expect(sql).not.toMatch(/pr_rollups/);
      expect(sql).not.toMatch(/daily_cost_by_user|daily_cost_by_model|daily_tool_usage/);
      expect(sql).not.toMatch(/refresh_continuous_aggregate/);
      // And it never rewrites cost_usd itself — the seed writes that at insert.
      expect(sql).not.toMatch(/\bcost_usd\s*=/);
    }
  });

  it('never adds the two columns together, in SQL or in TypeScript', () => {
    // In either operand order, in either spelling. `SUM(a + b)` on a dashboard
    // would look entirely plausible and bill the same dollars twice.
    const pairs: [string, string][] = [
      [ATTR, DOWN],
      [DOWN, ATTR],
      ['attributedCostUsd', 'downstreamCostUsd'],
      ['downstreamCostUsd', 'attributedCostUsd'],
    ];
    for (const [a, b] of pairs) {
      expect(SEED).not.toMatch(new RegExp(`${a}\\s*\\+\\s*${b}`));
    }
  });

  it('writes NULL rather than 0 where the shared function attributed nothing', () => {
    // `NULL = not attributed` is the rule the whole coverage indicator rests on.
    // A `?? 0` on either value would turn a gap in capture into a measurement.
    expect(SEED).toMatch(/r\.attributedCostUsd === null \? null :/);
    expect(SEED).toMatch(/r\.downstreamCostUsd === null \? null :/);
    expect(SEED).not.toMatch(/attributedCostUsd\s*\?\?\s*0/);
    expect(SEED).not.toMatch(/downstreamCostUsd\s*\?\?\s*0/);
  });
});
