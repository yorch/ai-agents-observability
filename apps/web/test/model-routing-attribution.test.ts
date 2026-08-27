import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for the bug fixed in P14-005.
 *
 * Six reads — four here, one in `projection-queries.ts`, one in the ingest alert
 * engine — asked "what did model M cost on tool category C?" as
 *
 *     SUM(cost_usd) WHERE event_type = 'PostToolUse'
 *                     AND model IS NOT NULL
 *                     AND tool_category IS NOT NULL
 *
 * `events.model` is written only from an event's `llm` block
 * (`apps/ingest/src/lib/insert-events.ts`), and every producer of that block
 * attaches it to a **`Stop`** event. So `model IS NOT NULL` matched zero tool
 * rows in real telemetry and the cost column was not even the binding
 * constraint: `/org/models`, the routing recommendations, the
 * projection-realization panel, the per-user routing hint and a live
 * `routing_waste` alert have only ever rendered rows fabricated by the seed.
 *
 * **The class of bug, not just this one predicate:** a query whose filters
 * cannot all be satisfied by any row a producer is able to emit. That is the
 * same class as P14-001's `tool_category = 'agent'`, which
 * `subagent-tool-category.test.ts` pins; this file extends the idea to the
 * `model`-on-a-tool-row predicate.
 *
 * **Why a source scan and not a unit test.** A mocked Prisma cannot fail on a
 * predicate the database would simply never match — a dead query and a correct
 * one both return `[]`. The evidence lives in the query text and in what the
 * producers write, so that is what is checked. Every scan below carries an
 * anti-vacuity assertion, because the way this kind of test dies is by finding
 * nothing and passing.
 */

const LIB = join(import.meta.dirname, '../src/lib');

/** Every routing read, and the file it lives in. Renaming one fails the scan. */
const ROUTING_READS = [
  ['org-queries.ts', 'getOrgModelRoutingBreakdown'],
  ['org-queries.ts', 'getRoutingSpendByTeam'],
  ['team-queries.ts', 'getTeamRoutingBreakdown'],
  ['insights-queries.ts', 'getUserModelRouting'],
  ['projection-queries.ts', 'getRoutingActuals'],
] as const;

/** The body of one exported function, up to the next top-level export. */
function functionBody(file: string, fn: string): string {
  const src = readFileSync(join(LIB, file), 'utf8');
  const start = src.indexOf(`function ${fn}(`);
  expect(start, `${fn} not found in ${file}`).toBeGreaterThan(-1);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('no routing read asks a tool row for a model', () => {
  it('finds every routing read it claims to check (the scan is not vacuous)', () => {
    for (const [file, fn] of ROUTING_READS) {
      expect(functionBody(file, fn).length, `${file}:${fn}`).toBeGreaterThan(200);
    }
  });

  it('confirms ingest writes `model` only from an `llm` block', () => {
    // The producer-side half of the claim. If this line ever stops being the
    // only source of the column, the predicate below stops being dead for the
    // reason stated — and this test should be revisited rather than deleted.
    const insert = readFileSync(
      join(import.meta.dirname, '../../ingest/src/lib/insert-events.ts'),
      'utf8',
    );
    // Written as a regex rather than a literal: `${…}` inside a plain string is
    // a lint error, and the point is the shape, not the exact spacing.
    expect(insert).toMatch(/\$\{e\.llm\?\.model \?\? null\}/);
    // The column list is positional; `model` must still be the field that
    // interpolation fills.
    expect(insert).toMatch(/model,\s*input_tokens,\s*output_tokens/);
  });

  it('resolves the model through the issuing turn in every routing read', () => {
    for (const [file, fn] of ROUTING_READS) {
      const body = functionBody(file, fn);
      // The P14-003 turn linkage: a tool row's `parent_event_id` is the
      // `event_id` of the Stop that closed the turn which issued it.
      expect(body, `${file}:${fn}`).toMatch(/turn\.event_id\s*=\s*tool\.parent_event_id/);
      expect(body, `${file}:${fn}`).toMatch(/turn\.event_type\s*=\s*'Stop'/);
    }
  });

  it('never constrains or selects a model on the tool-row alias', () => {
    // The dead predicate itself, plus the unaliased form it used to take. A
    // query that filters `event_type = 'PostToolUse'` and then asks that same
    // row for a model is asking for a row no adapter emits.
    for (const [file, fn] of ROUTING_READS) {
      const body = functionBody(file, fn);
      expect(body, `${file}:${fn}`).not.toMatch(/\btool\.model\b/);
      expect(body, `${file}:${fn}`).not.toMatch(/\bAND\s+model\s+IS\s+NOT\s+NULL/i);
    }
  });

  it('sums the issuing-turn share rather than the tool row cost', () => {
    for (const [file, fn] of ROUTING_READS) {
      const body = functionBody(file, fn);
      expect(body, `${file}:${fn}`).toMatch(/SUM\(tool\.attributed_cost_usd\)/);
      // `cost_usd` on a PostToolUse row is NULL by construction — the tokens are
      // on the Stop. Summing it was the second half of the same fiction.
      expect(body, `${file}:${fn}`).not.toMatch(/SUM\(\s*(?:tool\.)?cost_usd\s*\)/);
      // The downstream lens prices the FOLLOWING turn's input with the following
      // turn's model, so it cannot answer a question about this turn's routing.
      expect(body, `${file}:${fn}`).not.toContain('downstream_cost_usd');
    }
  });

  it('keeps the category on the tool row, where a producer writes it', () => {
    for (const [file, fn] of ROUTING_READS) {
      const body = functionBody(file, fn);
      expect(body, `${file}:${fn}`).toMatch(/tool\.tool_category/);
      expect(body, `${file}:${fn}`).not.toMatch(/turn\.tool_category/);
    }
  });

  it('bounds both sides of the self-join by the window', () => {
    // Without a `ts` predicate on the Stop side, the join degrades to an
    // event_id probe into every chunk of the hypertable.
    for (const [file, fn] of ROUTING_READS) {
      expect(functionBody(file, fn), `${file}:${fn}`).toMatch(/turn\.ts\s+>=/);
    }
  });
});

describe('an unattributable routing figure stays absent', () => {
  it('never collapses the routing sum to zero in SQL', () => {
    for (const [file, fn] of ROUTING_READS) {
      const body = functionBody(file, fn);
      expect(body, `${file}:${fn}`).not.toMatch(
        /COALESCE\s*\(\s*SUM\s*\(\s*tool\.attributed_cost_usd/i,
      );
    }
  });

  it('types the routing rows as nullable so a caller has to decide', () => {
    // The compiler is the enforcement: `attributedCostUsd: number | null` makes
    // every consumer confront "not attributed" instead of adding a silent zero.
    const org = readFileSync(join(LIB, 'org-queries.ts'), 'utf8');
    const insights = readFileSync(join(LIB, 'insights-queries.ts'), 'utf8');
    expect(org).toMatch(/attributedCostUsd:\s*number\s*\|\s*null/);
    expect(insights).toMatch(/attributedCostUsd:\s*number\s*\|\s*null/);
    // The old non-nullable field name must not survive on either row type.
    expect(org).not.toMatch(/OrgModelRoutingRow = \{[^}]*totalCostUsd/s);
  });

  it('aggregates routing spend with addNullable, never with +', () => {
    for (const file of ['routing-queries.ts', 'recommendations.ts', 'org-queries.ts']) {
      const src = readFileSync(join(LIB, file), 'utf8');
      expect(src, file).toContain('addNullable');
      expect(src, file).not.toMatch(/\+=\s*[\w.]*attributedCostUsd/);
    }
  });
});
