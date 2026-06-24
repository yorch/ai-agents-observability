import type { PriceTable } from '@ai-agents-observability/schemas';

// Cost is keyed on (agent_type, model): the caller resolves the agent's price
// table (see price-tables.ts) and passes it in, so two agents with same-named
// models price independently. Pass `agentType` to namespace unknown-model
// tracking by agent (P8-002).
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  priceTable: PriceTable,
  // Optional collector: (agent, model) pairs absent from the price table are
  // recorded here so the caller can surface them. Otherwise a new (unpriced)
  // model silently bills $0 despite real token usage, with no signal to update
  // the price table.
  unknownModels?: Set<string>,
  // When provided, unknown models are recorded as `<agentType>:<model>` so the
  // same model name under two agents doesn't dedup into one entry.
  agentType?: string,
): number {
  const price = priceTable.prices[model];
  if (!price) {
    unknownModels?.add(agentType ? `${agentType}:${model}` : model);
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
