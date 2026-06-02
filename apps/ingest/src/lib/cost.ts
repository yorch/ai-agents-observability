import type { PriceTable } from '@ai-agents-observability/schemas';

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  priceTable: PriceTable,
  // Optional collector: models absent from the price table are recorded here so
  // the caller can surface them. Otherwise a new (unpriced) model silently bills
  // $0 despite real token usage, with no signal to update the price table.
  unknownModels?: Set<string>,
): number {
  const price = priceTable.prices[model];
  if (!price) {
    unknownModels?.add(model);
    return 0;
  }
  return (
    (inputTokens * price.input_per_mtok +
      outputTokens * price.output_per_mtok +
      cacheReadTokens * price.cache_read_per_mtok +
      cacheCreationTokens * price.cache_write_per_mtok) /
    1_000_000
  );
}
