import type { PriceTable } from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';

import { computeCostUsd } from '../src/lib/cost';

const TABLE: PriceTable = {
  generated_at: '2026-08-18T00:00:00Z',
  prices: {
    'claude-opus-5': {
      cache_read_per_mtok: 0.5,
      cache_write_per_mtok: 6.25,
      input_per_mtok: 5,
      output_per_mtok: 25,
    },
    // A verbatim prefixed key, to prove the exact match wins over the fallback.
    'openrouter/claude-opus-5': {
      cache_read_per_mtok: 0,
      cache_write_per_mtok: 0,
      input_per_mtok: 1,
      output_per_mtok: 1,
    },
  },
  version: 'test',
};

describe('computeCostUsd', () => {
  it('bills each token count at its own rate', () => {
    // 1M input + 1M output + 1M cache read + 1M cache write.
    expect(computeCostUsd('claude-opus-5', 1e6, 1e6, 1e6, 1e6, TABLE)).toBeCloseTo(
      5 + 25 + 0.5 + 6.25,
      10,
    );
  });

  it('falls back to the bare model when the name carries a provider prefix', () => {
    const prefixed = computeCostUsd('anthropic/claude-opus-5', 1e6, 0, 0, 0, TABLE);
    expect(prefixed).toBeCloseTo(5, 10);
  });

  it('prefers a verbatim prefixed key over the stripped fallback', () => {
    // Would be 5 via the fallback; the exact row says 1.
    expect(computeCostUsd('openrouter/claude-opus-5', 1e6, 0, 0, 0, TABLE)).toBeCloseTo(1, 10);
  });

  it('strips only the first segment, so a deeper path stays unknown', () => {
    const unknown = new Set<string>();
    expect(computeCostUsd('a/b/claude-opus-5', 1e6, 0, 0, 0, TABLE, unknown)).toBe(0);
    expect(unknown).toContain('a/b/claude-opus-5');
  });

  it('bills $0 and records the unknown model, namespaced by agent', () => {
    const unknown = new Set<string>();
    expect(computeCostUsd('gpt-9', 1e6, 1e6, 0, 0, TABLE, unknown, 'codex')).toBe(0);
    expect(unknown).toContain('codex:gpt-9');
  });

  it('records the model as written, not the stripped fallback name', () => {
    const unknown = new Set<string>();
    computeCostUsd('groq/llama-4', 1e6, 0, 0, 0, TABLE, unknown, 'pi');
    expect(unknown).toContain('pi:groq/llama-4');
  });

  // P14-015. The request-denominated dimension is additive: `computeCostUsd`
  // never reads it, so a table that grows one prices its tokens identically, and
  // a model priced ONLY by request stays unknown rather than being quietly
  // costed on the wrong denominator. Which denominator a seat is billed on is a
  // property of its plan, which no event carries — so ingest must not choose.
  it('ignores request pricing when costing tokens', () => {
    const withRequests: PriceTable = {
      ...TABLE,
      request_pricing: {
        included_requests_per_seat_month: { pro: 300 },
        multipliers: { 'claude-opus-5': 27, 'request-only-model': 6 },
        overage_usd_per_request: 0.04,
      },
    };
    // Same table, same tokens, same dollars — the whole point of "unaffected".
    expect(computeCostUsd('claude-opus-5', 1e6, 1e6, 1e6, 1e6, withRequests)).toBe(
      computeCostUsd('claude-opus-5', 1e6, 1e6, 1e6, 1e6, TABLE),
    );
    // Anti-vacuity: that equality would also hold if both were zero.
    expect(computeCostUsd('claude-opus-5', 1e6, 1e6, 1e6, 1e6, TABLE)).toBeGreaterThan(0);

    const unknown = new Set<string>();
    expect(
      computeCostUsd('request-only-model', 1e6, 0, 0, 0, withRequests, unknown, 'copilot'),
    ).toBe(0);
    expect(unknown).toContain('copilot:request-only-model');
  });
});
