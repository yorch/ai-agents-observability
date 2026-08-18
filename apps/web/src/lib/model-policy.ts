import {
  type ModelPolicyOverrides,
  type ModelPolicySnapshot,
  type ModelTier,
  parseTierOverrides,
  resolveModelPolicySnapshot,
} from '@ai-agents-observability/schemas';
import { getModelPrices } from './price-client';
import { getPrisma } from './prisma';

// Web-side adapter for the shared model policy. The derivation and the merge
// semantics live in packages/schemas so apps/ingest resolves the identical
// policy; the only thing that differs between the two apps — and therefore the
// only thing implemented here — is where the prices come from (an HTTP fetch
// against ingest's /v1/price-table, versus ingest's in-process tables).

/** One agent's stored row, with the `Json` tier overrides already narrowed. */
export type StoredModelPolicy = {
  agentType: string;
  allowedModels: string[];
  cheapCategories: string[];
  tierOverrides: Record<string, ModelTier>;
};

export async function getModelPolicyOverrides(): Promise<Map<string, StoredModelPolicy>> {
  const rows = await getPrisma().modelPolicy.findMany();
  return new Map(
    rows.map((r) => [
      r.agentType as string,
      {
        agentType: r.agentType as string,
        allowedModels: r.allowedModels,
        cheapCategories: r.cheapCategories,
        tierOverrides: parseTierOverrides(r.tierOverrides),
      },
    ]),
  );
}

/**
 * Build the resolved policy for one agent. `prices` is passed in rather than
 * fetched here so a caller resolving several agents pays for one price-table
 * fetch per agent and no more, and so this stays testable without network.
 */
export function buildModelPolicy(
  agentType: string,
  prices: Record<string, { input_per_mtok: number; output_per_mtok: number }> | null,
  overrides?: ModelPolicyOverrides,
): ModelPolicySnapshot {
  return resolveModelPolicySnapshot(agentType, prices ?? {}, overrides);
}

/**
 * Resolve policies for every agent that has observed routing spend. An agent
 * whose price table is unreachable or empty still gets a snapshot, just one with
 * no rates — so callers see "unpriced", never a fabricated tier.
 */
export async function getModelPolicies(
  agentTypes: string[],
): Promise<Map<string, ModelPolicySnapshot>> {
  const unique = [...new Set(agentTypes)];
  const overrides = await getModelPolicyOverrides();
  const entries = await Promise.all(
    unique.map(async (agentType) => {
      // events.agent_type is UPPER_SNAKE_CASE; the price-table keys are lower.
      const prices = await getModelPrices(agentType.toLowerCase());
      return [agentType, buildModelPolicy(agentType, prices, overrides.get(agentType))] as const;
    }),
  );
  return new Map(entries);
}
