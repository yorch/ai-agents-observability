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
    // Three arrays plus the window start. If this ever scales with the number
    // of priced models, the inlined form has come back.
    expect(values).toHaveLength(4);
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

  it('stays inert when the threshold is not positive', async () => {
    const { db, $queryRaw } = captureSql();
    expect(await evalRoutingWaste(db, { thresholdUsd: 0 })).toBeNull();
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
