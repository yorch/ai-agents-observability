import { describe, expect, it } from 'vitest';
import {
  type AttributionEvent,
  computeSessionAttribution,
  inputSideCostUsd,
  type PriceLookup,
} from './cost-attribution';
import type { ModelPrice } from './price-table';

/**
 * The arithmetic behind `attributed_cost_usd` and `downstream_cost_usd`
 * (P14-004). These are the numbers the product will print next to a dollar sign,
 * so each definition gets a test that would fail if someone "simplified" it:
 * the even split, the ≤-session-total inequality that falls out of turns with no
 * tools, the refusal to attribute anything without turn linkage, and the
 * downstream proportions summing to one.
 */

const PRICE: ModelPrice = {
  cache_read_per_mtok: 1,
  cache_write_per_mtok: 10,
  input_per_mtok: 4,
  output_per_mtok: 100,
};

const priceFor: PriceLookup = (_agent, model) => (model === 'test-model' ? PRICE : undefined);
const noPrices: PriceLookup = () => undefined;

const T0 = new Date('2026-08-20T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let seq = 0;
function ev(over: Partial<AttributionEvent>): AttributionEvent {
  seq += 1;
  return {
    agentType: 'CLAUDE_CODE',
    cacheCreationTokens: null,
    cacheReadTokens: null,
    costUsd: null,
    eventId: `e${seq}`,
    eventType: 'PostToolUse',
    inputTokens: null,
    model: null,
    toolOutputBytes: null,
    ts: at(seq),
    turnNumber: 1,
    ...over,
  };
}

function stop(turnNumber: number, over: Partial<AttributionEvent> = {}): AttributionEvent {
  return ev({ eventType: 'Stop', model: 'test-model', turnNumber, ...over });
}

function tool(turnNumber: number, over: Partial<AttributionEvent> = {}): AttributionEvent {
  return ev({ eventType: 'PostToolUse', turnNumber, ...over });
}

describe('issuing-turn share', () => {
  it('splits a turn evenly across the tool calls it issued', () => {
    const rows = computeSessionAttribution(
      [stop(1, { costUsd: 0.9 }), tool(1), tool(1), tool(1)],
      priceFor,
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.attributedCostUsd)).toEqual([0.3, 0.3, 0.3]);
  });

  it('leaves a turn that issued no tools entirely unattributed', () => {
    // This is the whole reason the column sums to LESS than the session total:
    // a turn spent thinking (or answering in prose) has no tool call to carry
    // its cost, and inventing one would inflate whatever it was pinned to.
    const rows = computeSessionAttribution([stop(1, { costUsd: 5 })], priceFor);

    expect(rows).toEqual([]);
  });

  it('sums to at most the session total, never more', () => {
    const events = [
      stop(1, { costUsd: 1 }), // 2 tools -> 0.5 each
      tool(1),
      tool(1),
      stop(2, { costUsd: 4 }), // no tools -> unattributed
      stop(3, { costUsd: 2 }), // 1 tool  -> 2
      tool(3),
    ];
    const sessionTotal = 1 + 4 + 2;

    const attributed = computeSessionAttribution(events, priceFor).reduce(
      (sum, r) => sum + (r.attributedCostUsd ?? 0),
      0,
    );

    expect(attributed).toBeCloseTo(3, 10);
    expect(attributed).toBeLessThan(sessionTotal);
  });

  it('attributes nothing when the turn has no priced Stop event', () => {
    // A turn whose Stop never arrived, or arrived with no cost, is not a
    // $0.00 turn — it is an unknown one. NULL says so; 0 would not.
    const rows = computeSessionAttribution([tool(1), tool(1)], priceFor);

    expect(rows).toEqual([]);
  });
});

describe('turn linkage is required', () => {
  it('attributes nothing when turn_number is NULL on every row', () => {
    // The state of every live Claude Code session until the hook reports
    // linkage. Producing no attribution here is the point: the alternative is a
    // confident wrong number.
    const rows = computeSessionAttribution(
      [
        stop(1, { costUsd: 3, turnNumber: null }),
        tool(1, { toolOutputBytes: 100, turnNumber: null }),
        tool(1, { toolOutputBytes: 100, turnNumber: null }),
      ],
      priceFor,
    );

    expect(rows).toEqual([]);
  });

  it('attributes the linked turns of a partly-linked session and no others', () => {
    const rows = computeSessionAttribution(
      [stop(1, { costUsd: 1 }), tool(1), tool(1, { turnNumber: null })],
      priceFor,
    );

    // One linked tool in turn 1 -> it takes the whole turn. The unlinked row
    // does not join the divisor and gets nothing.
    expect(rows).toEqual([
      expect.objectContaining({ attributedCostUsd: 1, downstreamCostUsd: null }),
    ]);
  });
});

describe('downstream inflation', () => {
  it('apportions the next turn by output bytes, and the shares sum to one', () => {
    // Turn 2 reads 1,000,000 input tokens at $4/Mtok = $4.00 of input-side cost.
    // Turn 1's two tools produced 250 and 750 bytes, so 25% / 75%.
    const rows = computeSessionAttribution(
      [
        stop(1, { costUsd: 0 }),
        tool(1, { toolOutputBytes: 250 }),
        tool(1, { toolOutputBytes: 750 }),
        stop(2, { costUsd: 9, inputTokens: 1_000_000 }),
      ],
      priceFor,
    );

    const downstream = rows.map((r) => r.downstreamCostUsd);
    expect(downstream).toEqual([1, 3]);
    expect(downstream.reduce((s: number, d) => s + (d ?? 0), 0)).toBeCloseTo(4, 10);
  });

  it('counts cache reads and cache writes', () => {
    // 1M cache-read at $1/Mtok + 1M cache-write at $10/Mtok = $11. Output
    // tokens are the model's own generation — nothing a tool's output caused —
    // and are structurally excluded: `AttributionEvent` does not carry them, so
    // a future edit cannot fold them in without changing the type first.
    const rows = computeSessionAttribution(
      [
        stop(1, { costUsd: 0 }),
        tool(1, { toolOutputBytes: 10 }),
        stop(2, {
          cacheCreationTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          costUsd: 0,
        }),
      ],
      priceFor,
    );

    expect(rows[0]?.downstreamCostUsd).toBe(11);
  });

  it('attributes nothing downstream when there is no following turn', () => {
    const rows = computeSessionAttribution(
      [stop(1, { costUsd: 2 }), tool(1, { toolOutputBytes: 500 })],
      priceFor,
    );

    expect(rows[0]?.downstreamCostUsd).toBeNull();
  });

  it('attributes nothing downstream when no tool in the turn reported output bytes', () => {
    // Nothing to apportion by. Splitting evenly instead would be a second,
    // undocumented definition of the same column.
    const rows = computeSessionAttribution(
      [stop(1, { costUsd: 2 }), tool(1), tool(1), stop(2, { inputTokens: 1_000_000 })],
      priceFor,
    );

    expect(rows.map((r) => r.downstreamCostUsd)).toEqual([null, null]);
  });

  it('attributes nothing downstream when the following turn used an unpriced model', () => {
    // Same rule as ingest (P8-002): an unknown model is not priced at zero, it
    // is not priced.
    const rows = computeSessionAttribution(
      [
        stop(1, { costUsd: 2 }),
        tool(1, { toolOutputBytes: 500 }),
        stop(2, { inputTokens: 1_000_000 }),
      ],
      noPrices,
    );

    expect(rows[0]?.attributedCostUsd).toBe(2);
    expect(rows[0]?.downstreamCostUsd).toBeNull();
  });
});

describe('the two columns are two lenses, not two costs', () => {
  it('reports the same dollars under both names for adjacent turns', () => {
    // Turn 2 costs $4, all of it input-side. It appears once as turn 2's own
    // issuing share (on turn 2's tool) and once as turn 1's tool's downstream
    // inflation. Summing the column would bill it twice — which is exactly why
    // nothing in the product may add these together.
    const rows = computeSessionAttribution(
      [
        stop(1, { costUsd: 0 }),
        tool(1, { toolOutputBytes: 100 }),
        stop(2, { costUsd: 4, inputTokens: 1_000_000 }),
        tool(2, { toolOutputBytes: 100 }),
      ],
      priceFor,
    );

    const turn1Tool = rows[0];
    const turn2Tool = rows[1];
    expect(turn1Tool?.downstreamCostUsd).toBe(4);
    expect(turn2Tool?.attributedCostUsd).toBe(4);
    // The naive total. Written out so the failure of a future "just add them"
    // change is visible here rather than on a dashboard.
    const naiveTotal = rows.reduce(
      (s, r) => s + (r.attributedCostUsd ?? 0) + (r.downstreamCostUsd ?? 0),
      0,
    );
    expect(naiveTotal).toBe(8);
    expect(naiveTotal).toBeGreaterThan(4);
  });
});

describe('determinism', () => {
  it('produces identical output on a second pass over the same events', () => {
    // The property the job's idempotency rests on: nothing here reads the
    // clock, and nothing reads what is already stored.
    const events = [
      stop(1, { costUsd: 0.7 }),
      tool(1, { toolOutputBytes: 33 }),
      tool(1, { toolOutputBytes: 67 }),
      stop(2, { cacheReadTokens: 250_000, costUsd: 1.1, inputTokens: 500_000 }),
      tool(2, { toolOutputBytes: 5 }),
    ];

    expect(computeSessionAttribution(events, priceFor)).toEqual(
      computeSessionAttribution(events, priceFor),
    );
  });
});

describe('inputSideCostUsd', () => {
  it('is null for an unpriced model and null for no model at all', () => {
    expect(inputSideCostUsd(stop(1, { inputTokens: 100 }), noPrices)).toBeNull();
    expect(inputSideCostUsd(stop(1, { inputTokens: 100, model: null }), priceFor)).toBeNull();
  });

  it('treats missing token counts as zero rather than as unknown', () => {
    expect(inputSideCostUsd(stop(1), priceFor)).toBe(0);
  });
});
