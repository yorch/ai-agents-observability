import { describe, expect, it } from 'vitest';

import { isRequestPriced, PriceTableSchema, requestCostUsd } from './price-table';

describe('PriceTableSchema', () => {
  const validTable = {
    generated_at: '2026-05-01T00:00:00Z',
    prices: {
      'claude-sonnet-4-6': {
        cache_read_per_mtok: 0.3,
        cache_write_per_mtok: 3.75,
        input_per_mtok: 3,
        output_per_mtok: 15,
      },
    },
    version: '2026-05-01',
  };

  const requestTable = {
    generated_at: '2026-05-01T00:00:00Z',
    prices: {},
    request_pricing: {
      included_requests_per_seat_month: { plus: 1500, pro: 300 },
      multipliers: { 'base-model': 0, 'costly-model': 10, 'standard-model': 1 },
      overage_usd_per_request: 0.04,
    },
    version: '2026-05-01',
  };

  it('accepts empty price maps for a newly scaffolded agent table', () => {
    expect(PriceTableSchema.safeParse({ ...validTable, prices: {} }).success).toBe(true);
  });

  it('rejects generated_at values without a timezone offset', () => {
    expect(
      PriceTableSchema.safeParse({ ...validTable, generated_at: '2026-05-01T00:00:00' }).success,
    ).toBe(false);
  });

  // P14-015. Both denominators are first-class; neither shape may need the other.
  it('accepts a request-denominated table that carries no token rates', () => {
    const parsed = PriceTableSchema.safeParse(requestTable);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.request_pricing?.overage_usd_per_request).toBe(0.04);
  });

  it('leaves a token-denominated table without request pricing', () => {
    const parsed = PriceTableSchema.parse(validTable);
    expect(parsed.request_pricing).toBeUndefined();
    expect(isRequestPriced(parsed)).toBe(false);
    // Anti-vacuity: the token side still parsed, so the assertion above is about
    // an absent optional field and not about a table that failed to parse.
    expect(Object.keys(parsed.prices)).toHaveLength(1);
  });

  it('rejects a malformed request_pricing block rather than dropping it', () => {
    // Each case is a single mutation of a table that IS valid — the assertion
    // below pins that, so these cannot pass by being malformed some other way.
    expect(PriceTableSchema.safeParse(requestTable).success).toBe(true);

    const malformed = [
      { ...requestTable, request_pricing: { ...requestTable.request_pricing, multipliers: {} } },
      {
        ...requestTable,
        request_pricing: { ...requestTable.request_pricing, multipliers: { m: -1 } },
      },
      {
        ...requestTable,
        request_pricing: { ...requestTable.request_pricing, overage_usd_per_request: -0.04 },
      },
      {
        ...requestTable,
        request_pricing: { ...requestTable.request_pricing, overage_usd_per_request: '0.04' },
      },
      {
        ...requestTable,
        request_pricing: { ...requestTable.request_pricing, multipliers: { m: 'one' } },
      },
      // Missing keys, one at a time — every field of the block is required.
      {
        ...requestTable,
        request_pricing: {
          multipliers: requestTable.request_pricing.multipliers,
          overage_usd_per_request: 0.04,
        },
      },
      {
        ...requestTable,
        request_pricing: {
          included_requests_per_seat_month: { pro: 300 },
          overage_usd_per_request: 0.04,
        },
      },
      {
        ...requestTable,
        request_pricing: {
          included_requests_per_seat_month: { pro: 300 },
          multipliers: requestTable.request_pricing.multipliers,
        },
      },
    ];
    // `multipliers: {}` is the one case that is structurally fine — an empty map
    // parses. It is listed first so the count below stays honest about it.
    expect(PriceTableSchema.safeParse(malformed[0]).success).toBe(true);
    for (const table of malformed.slice(1)) {
      expect(PriceTableSchema.safeParse(table).success, JSON.stringify(table)).toBe(false);
    }
    expect(malformed.length).toBeGreaterThan(5);
  });
});

describe('requestCostUsd', () => {
  const pricing = {
    included_requests_per_seat_month: { pro: 300 },
    multipliers: { 'base-model': 0, 'costly-model': 10, 'standard-model': 1 },
    overage_usd_per_request: 0.04,
  };

  it('bills a request at multiplier x the overage rate', () => {
    expect(requestCostUsd('standard-model', pricing)).toBeCloseTo(0.04, 10);
    expect(requestCostUsd('costly-model', pricing)).toBeCloseTo(0.4, 10);
  });

  it('bills a zero-multiplier model at $0 — genuinely free, not unknown', () => {
    expect(requestCostUsd('base-model', pricing)).toBe(0);
  });

  it('returns undefined for a model the table does not price', () => {
    // Distinct from the $0 above: "we cannot say" must not render as "free".
    expect(requestCostUsd('never-heard-of-it', pricing)).toBeUndefined();
  });
});
