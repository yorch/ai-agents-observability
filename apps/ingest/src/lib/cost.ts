import type { ModelPrice, PriceTable } from '@ai-agents-observability/schemas';

// Provider-agnostic agents (opencode, Pi, omp) route through OpenRouter and
// friends, which name models `<provider>/<model>` — `anthropic/claude-opus-5` is
// the same model, and the same rate, as `claude-opus-5`. Try the exact key first,
// so a table can still price a prefixed name differently by listing it verbatim;
// only on a miss strip one leading segment. Anything still unmatched stays
// unknown and bills $0, which is the P8-002 signal to extend the table.
export function resolveModelPrice(model: string, priceTable: PriceTable): ModelPrice | undefined {
  const exact = priceTable.prices[model];
  if (exact) {
    return exact;
  }
  const slash = model.indexOf('/');
  return slash === -1 ? undefined : priceTable.prices[model.slice(slash + 1)];
}

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
  const price = resolveModelPrice(model, priceTable);
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
