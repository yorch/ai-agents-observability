import type { PrismaClient } from '@ai-agents-observability/db';
import {
  estimateRoutingSavings,
  type ModelPolicySnapshot,
  resolveModelPolicySnapshot,
} from '@ai-agents-observability/schemas';
import { pricedAgentTypes, priceTableFor } from './price-tables';

// Ingest-side resolution of the shared model policy (P10-002). apps/web resolves
// the same thing over HTTP against /v1/price-table; here the tables are already
// in-process, so this reads them directly. The derivation and the semantics live
// in packages/schemas so the two apps cannot drift — which is the whole point of
// the policy existing.

export type PolicyOverrideRow = {
  agentType: string;
  allowedModels: string[];
  cheapCategories: string[];
  tierOverrides: unknown;
};

export async function loadPolicyOverrides(
  db: Pick<PrismaClient, 'modelPolicy'>,
): Promise<PolicyOverrideRow[]> {
  const rows = await db.modelPolicy.findMany();
  return rows.map((r) => ({
    agentType: r.agentType as string,
    allowedModels: r.allowedModels,
    cheapCategories: r.cheapCategories,
    tierOverrides: r.tierOverrides,
  }));
}

/** One resolved snapshot per agent that ships a price table. */
export function resolveIngestModelPolicies(
  overrides: PolicyOverrideRow[],
): Map<string, ModelPolicySnapshot> {
  const byAgent = new Map(overrides.map((o) => [o.agentType.toUpperCase(), o]));
  const out = new Map<string, ModelPolicySnapshot>();

  for (const agentKey of pricedAgentTypes()) {
    // events.agent_type is stored UPPER_SNAKE_CASE; the table keys are lowercase.
    const agentType = agentKey.toUpperCase();
    const table = priceTableFor(agentKey);
    const prices = table?.prices ?? {};
    const override = byAgent.get(agentType);

    out.set(agentType, resolveModelPolicySnapshot(agentType, prices, override));
  }
  return out;
}

/**
 * Flatten policies into `(agent_type, model, tool_category)` triples for models
 * that have somewhere cheaper to go. Joining these as a VALUES list keeps the
 * "what is expensive" decision in one place rather than restating it as a SQL
 * literal that silently only matches one vendor.
 */
export function downgradeableTriples(
  policies: Map<string, ModelPolicySnapshot>,
): { agentType: string; model: string; toolCategory: string }[] {
  const out: { agentType: string; model: string; toolCategory: string }[] = [];
  for (const policy of policies.values()) {
    for (const model of Object.keys(policy.tiers)) {
      if (estimateRoutingSavings(policy, model) === null) {
        continue;
      }
      for (const toolCategory of policy.cheapCategories) {
        out.push({ agentType: policy.agentType, model, toolCategory });
      }
    }
  }
  return out;
}
