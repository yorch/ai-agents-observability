import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The seed may only write columns a producer can actually write (P14-005).
 *
 * ── Why this is a test and not a convention ──────────────────────────────────
 *
 * `packages/db/src/seed.ts` is the only data most of this product is ever
 * developed and reviewed against. When it writes a column that ingest never
 * writes, a query filtered on that column looks alive in every screenshot, in
 * every demo and in every PR review, and is dead the moment it meets real
 * telemetry.
 *
 * That is not hypothetical. Six routing reads — `/org/models`, the routing
 * recommendations, the projection-realization panel, the per-user routing hint,
 * the by-team accountability table and the `routing_waste` alert — filtered
 * `event_type = 'PostToolUse' AND model IS NOT NULL` for the entire life of the
 * feature. `events.model` is written from an event's `llm` block
 * (`apps/ingest/src/lib/insert-events.ts`) and every adapter attaches that block
 * to a `Stop`, so the predicate matched **zero** rows in production. The seed
 * fabricated a model on tool rows, so the surfaces rendered, Phase 10 was signed
 * off, and an armed alert stayed silent.
 *
 * The generalizable rule this pins: **an event's LLM columns belong to the
 * `Stop` that closes its turn, and to nothing else.**
 *
 * ── What it checks ───────────────────────────────────────────────────────────
 *
 * Every `INSERT INTO events (...) VALUES (...)` in the seed is parsed for its
 * column list and its `event_type` literals. An insert naming a per-turn LLM
 * column has to be provably a `Stop` insert — every event-type literal in its
 * VALUES clause is `'Stop'`. An insert whose type is chosen at runtime is not
 * provable and therefore may not name one, which is the conservative direction:
 * the cost of being wrong here is a query that looks alive for a year.
 *
 * The two anti-vacuity assertions matter as much as the rule: this shape of test
 * dies by finding nothing and passing.
 */

const SEED = join(import.meta.dirname, '../src/seed.ts');

/**
 * Columns ingest writes only from an event's `llm` block, which no producer
 * attaches to anything but a `Stop`.
 */
const TURN_ONLY_COLUMNS = [
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
] as const;

type SeedInsert = {
  columns: string[];
  /** Event-type literals appearing in the VALUES clause. */
  eventTypes: string[];
  values: string;
};

/** Every `INSERT INTO events (…) VALUES (…)` statement in the seed. */
function seedEventInserts(): SeedInsert[] {
  const src = readFileSync(SEED, 'utf8');
  const re = /INSERT INTO events\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*\n\s*ON CONFLICT/g;
  return [...src.matchAll(re)].map((m) => {
    const values = m[2] as string;
    return {
      columns: (m[1] as string)
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
      // `'PostToolUse'`, `${isTool ? 'PostToolUse' : 'SessionStart'}`, … — every
      // quoted event-type name the VALUES clause can produce.
      eventTypes: [
        ...values.matchAll(
          /'(SessionStart|SessionEnd|UserPromptSubmit|PreToolUse|PostToolUse|Notification|Stop|PreCompact)'/g,
        ),
      ].map((e) => e[1] as string),
      values,
    };
  });
}

const INSERTS = seedEventInserts();

describe('the seed writes only what a producer writes', () => {
  it('parses a plausible number of event inserts (the scan is not vacuous)', () => {
    // If a refactor changes the statement shape, this fails loudly rather than
    // letting the rule below pass over an empty list.
    expect(INSERTS.length).toBeGreaterThan(6);
    for (const insert of INSERTS) {
      expect(insert.columns).toContain('event_id');
      expect(insert.columns).toContain('event_type');
    }
    // …and the event-type literals are actually being read out, or the "is this
    // a Stop?" question below would answer "no" for every statement and the
    // rule would hold vacuously in the strict direction.
    const seen = new Set(INSERTS.flatMap((i) => i.eventTypes));
    expect(seen).toContain('Stop');
    expect(seen).toContain('PostToolUse');
  });

  it('still seeds at least one Stop carrying real per-turn usage', () => {
    // The other half of anti-vacuity: a seed that simply stopped writing token
    // columns anywhere would satisfy the rule and leave every cost surface
    // empty. At least one insert must be a Stop that carries the usage.
    const turnEnds = INSERTS.filter(
      (i) => i.eventTypes.includes('Stop') && i.columns.includes('cost_usd'),
    );
    expect(turnEnds.length).toBeGreaterThan(0);
    for (const col of TURN_ONLY_COLUMNS) {
      expect(
        turnEnds.some((i) => i.columns.includes(col)),
        `no seeded Stop writes ${col}`,
      ).toBe(true);
    }
  });

  it('never writes a per-turn LLM column on a row that cannot be a Stop', () => {
    const offenders = INSERTS.flatMap((insert) => {
      const named = TURN_ONLY_COLUMNS.filter((c) => insert.columns.includes(c));
      if (named.length === 0) {
        return [];
      }
      // Provably a Stop: at least one event-type literal, and all of them
      // `'Stop'`. An insert whose type is interpolated proves nothing and is
      // rejected — a per-column ternary could be correct at runtime, but the
      // seed is the artifact every reviewer checks a query against, and it
      // should be readable as safe without running it.
      const provablyStop =
        insert.eventTypes.length > 0 && insert.eventTypes.every((t) => t === 'Stop');
      if (provablyStop) {
        return [];
      }
      return [`${insert.eventTypes.join('|') || '<interpolated>'} writes ${named.join(', ')}`];
    });

    expect(offenders).toEqual([]);
  });

  it('keeps the turn linkage on the tool rows that the routing reads join through', () => {
    // The redistribution reads a tool row's `parent_event_id` to reach the Stop
    // that chose the model. A seed that stopped writing it would make every
    // routing surface empty for a reason that looks like the bug it replaced.
    const toolInserts = INSERTS.filter((i) => i.eventTypes.includes('PostToolUse'));
    expect(toolInserts.length).toBeGreaterThan(0);
    expect(toolInserts.some((i) => i.columns.includes('parent_event_id'))).toBe(true);
    expect(toolInserts.every((i) => i.columns.includes('tool_category'))).toBe(true);
  });
});
