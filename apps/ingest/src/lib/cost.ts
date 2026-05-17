import type { PriceTable } from '@ai-agents-observability/schemas';

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  priceTable: PriceTable,
): number {
  const price = priceTable.prices[model];
  if (!price) return 0;
  return (
    inputTokens * price.input_per_mtok +
    outputTokens * price.output_per_mtok +
    cacheReadTokens * price.cache_read_per_mtok +
    cacheCreationTokens * price.cache_write_per_mtok
  ) / 1_000_000;
}
