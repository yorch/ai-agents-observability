import { describe, expect, it, vi } from 'vitest';

import { evalRoutingWaste } from '../src/jobs/evaluate-alerts.ts';
import { pricedAgentTypes } from '../src/lib/price-tables.ts';

// The routing_waste evaluator joins a policy-derived set of downgradeable
// (agent, model, category) triples. P12-012 regenerated three price tables from
// the models.dev catalog and took them from 34 models to ~243 each, which grew
// that set from ~250 triples to ~1100. These tests pin the two properties that
// keep it from being a problem, both of which a plausible refactor would undo.

type Db = Parameters<typeof evalRoutingWaste>[0];

function captureSql() {
  const $queryRaw = vi.fn(async () => [{ waste: 0 }]);
  const modelPolicy = { findMany: vi.fn(async () => []) };
  return {
    $queryRaw,
    db: { $queryRaw, modelPolicy } as unknown as Db,
    sql: () => {
      const arg = $queryRaw.mock.calls[0]?.[0] as { strings?: string[]; values?: unknown[] };
      return { text: (arg?.strings ?? []).join('?'), values: arg?.values ?? [] };
    },
  };
}

describe('evalRoutingWaste query shape', () => {
  it('passes the downgradeable set as arrays, not an inlined VALUES list', async () => {
    const { db, sql } = captureSql();
    await evalRoutingWaste(db, { thresholdUsd: 25 });
    const { text } = sql();
    expect(text).toContain('unnest(');
    // A VALUES literal makes the query TEXT grow with the price tables, so
    // Postgres can never reuse a plan and every policy edit is a new statement.
    expect(text).not.toMatch(/JOIN\s*\(VALUES/i);
  });

  it('binds a fixed number of parameters regardless of table size', async () => {
    const { db, sql } = captureSql();
    await evalRoutingWaste(db, { thresholdUsd: 25 });
    const { values } = sql();
    // Three arrays plus the window start, which is bound twice — once for the
    // tool scan and once for the issuing-turn scan it joins to (P14-005), so
    // Postgres can prune chunks on both sides of the hypertable self-join. If
    // this ever scales with the number of priced models, the inlined form has
    // come back.
    expect(values).toHaveLength(5);
    const arrays = values.filter((v) => Array.isArray(v)) as string[][];
    expect(arrays).toHaveLength(3);
    // All three arrays must be the same length — `unnest` zips them
    // positionally and pads the short one with NULL.
    const lengths = new Set(arrays.map((a) => a.length));
    expect(lengths.size).toBe(1);
    expect([...lengths][0]).toBeGreaterThan(100);

    // Order matters and is invisible to a length check: swapping the unnest
    // arguments would join agent_type against model strings and silently match
    // nothing, while every shape assertion above still passed.
    // Identify each array by MEMBERSHIP, not by casing: the models.dev catalog
    // ships vendor-cased ids (`MiniMax-M2`), so a case test would be wrong.
    const [agents, models, categories] = arrays as [string[], string[], string[]];
    const knownAgents = new Set(pricedAgentTypes().map((a) => a.toUpperCase()));
    expect(agents.every((a) => knownAgents.has(a))).toBe(true);
    expect(agents).toContain('CLAUDE_CODE');
    expect(new Set(categories)).toEqual(new Set(['fs_read', 'search']));
    // A model id is never an agent type or a tool category, so a swapped
    // argument would land values in a column that cannot hold them.
    expect(models.some((m) => knownAgents.has(m))).toBe(false);
    expect(models.some((m) => m === 'fs_read' || m === 'search')).toBe(false);
  });

  // ── P14-005 ────────────────────────────────────────────────────────────────
  //
  // This alert was armed and permanently silent. It joined `dm.model = e.model`
  // on a row already restricted to `event_type = 'PostToolUse'`, and no producer
  // has ever put a model on a tool row: `events.model` is written from an event's
  // `llm` block and every adapter attaches that to a `Stop`. Every shape
  // assertion above passed while the evaluator matched nothing.
  //
  // So the shape that matters is not just "is it fast" but "can a row satisfy
  // it at all". These three pin the redistribution: model off the issuing turn,
  // dollars off the tool row's attributed share, category off the tool row.
  it('resolves the model through the issuing turn, never off the tool row', async () => {
    const { db, sql } = captureSql();
    await evalRoutingWaste(db, { thresholdUsd: 25 });
    const { text } = sql();

    // The turn linkage (P14-003) is what reaches the Stop that chose the model.
    expect(text).toMatch(/turn\.event_id\s*=\s*tool\.parent_event_id/);
    expect(text).toMatch(/turn\.event_type\s*=\s*'Stop'/);
    expect(text).toMatch(/dm\.model\s*=\s*turn\.model/);

    // The dead predicate, in either of the two forms it could come back as.
    expect(text).not.toMatch(/dm\.model\s*=\s*(?:tool|e)\.model/);
    expect(text).not.toMatch(/\btool\.model\b/);
  });

  it('sums the attributed turn share, not a tool row cost that is always NULL', async () => {
    const { db, sql } = captureSql();
    await evalRoutingWaste(db, { thresholdUsd: 25 });
    const { text } = sql();

    expect(text).toMatch(/SUM\(tool\.attributed_cost_usd\)/);
    // `downstream_cost_usd` is the FOLLOWING turn's input-side cost, priced with
    // the following turn's model. Charging it to this turn's model would answer
    // a different question at the wrong rates, and adding the two double-counts.
    expect(text).not.toContain('downstream_cost_usd');
    // No COALESCE to 0: "nothing attributed" must not read as "no waste".
    expect(text).not.toMatch(/COALESCE\s*\(\s*SUM\s*\(\s*tool\.attributed_cost_usd/i);
  });

  it('does not fire when nothing in the window could be attributed', async () => {
    // A window with matching calls but no turn linkage sums to NULL. Firing on
    // that as $0 would be harmless; treating NULL as a measurement of zero waste
    // is what would be wrong, and the alert reports its coverage when it does
    // fire so a quiet alert can be told apart from an uncapturable one.
    const $queryRaw = vi.fn(async () => [{ attributed_calls: 0n, call_count: 4200n, waste: null }]);
    const db = {
      $queryRaw,
      modelPolicy: { findMany: vi.fn(async () => []) },
    } as unknown as Db;

    expect(await evalRoutingWaste(db, { thresholdUsd: 1 })).toBeNull();
  });

  it('carries attribution coverage in details when it does fire', async () => {
    const $queryRaw = vi.fn(async () => [
      { attributed_calls: 900n, call_count: 1000n, waste: '250.5' },
    ]);
    const db = {
      $queryRaw,
      modelPolicy: { findMany: vi.fn(async () => []) },
    } as unknown as Db;

    const evaluation = await evalRoutingWaste(db, { thresholdUsd: 25 });
    expect(evaluation?.details).toMatchObject({
      attributedCalls: 900,
      callCount: 1000,
      wasteUsd: 250.5,
    });
    // Numbers only — the same discipline every other evaluator's details keep.
    for (const value of Object.values(evaluation?.details ?? {})) {
      expect(typeof value).toBe('number');
    }
  });

  it('stays inert when the threshold is not positive', async () => {
    const { db, $queryRaw } = captureSql();
    expect(await evalRoutingWaste(db, { thresholdUsd: 0 })).toBeNull();
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
