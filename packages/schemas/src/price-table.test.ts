import { describe, expect, it } from 'vitest';

import { PriceTableSchema } from './price-table';

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

  it('accepts empty price maps for a newly scaffolded agent table', () => {
    expect(PriceTableSchema.safeParse({ ...validTable, prices: {} }).success).toBe(true);
  });

  it('rejects generated_at values without a timezone offset', () => {
    expect(
      PriceTableSchema.safeParse({ ...validTable, generated_at: '2026-05-01T00:00:00' }).success,
    ).toBe(false);
  });
});
