import type { PriceTable } from '@ai-agents-observability/schemas';

// Price table is keyed by model string only. Per-agent disambiguation happens
// naturally because model names are vendor-specific (e.g. claude-opus-4-8 vs
// gpt-4o). If two agents ever share a model name, add _agentType to the
// signature and use (agentType, model) as the lookup key — the seam is here.
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
  // Placeholder for future (agentType, model) disambiguation — ignored for now
  // since model names are unique across vendors.
  _agentType?: string,
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
