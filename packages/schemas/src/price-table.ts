import { z } from 'zod';

const ModelPriceSchema = z.object({
  cache_read_per_mtok: z.number().nonnegative(),
  cache_write_per_mtok: z.number().nonnegative(),
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
});

export const PriceTableSchema = z.object({
  generated_at: z.iso.datetime({ offset: true }),
  prices: z.record(z.string(), ModelPriceSchema),
  version: z.string(),
});

export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export type PriceTable = z.infer<typeof PriceTableSchema>;
