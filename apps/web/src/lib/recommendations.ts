import {
  estimateRoutingSavings,
  isCheapCategory,
  MIN_SAVINGS_RATIO,
  type ModelPolicySnapshot,
} from '@ai-agents-observability/schemas';
import { addNullable } from './attribution-coverage';
import type { FrictionSources } from './effectiveness-queries';
import type {
  McpUsageRow,
  ToolPerfRow,
  UserCacheSummaryRow,
  UserModelRoutingRow,
} from './insights-queries';
import { MIN_ROUTING_CHEAP_CALLS, MIN_ROUTING_CHEAP_SPEND_USD } from './routing-queries';

// Actionable, per-developer coaching surface (Feature 5). Pure derivation over the
// friction-source decomposition and the already-fetched per-tool / MCP / routing
// signals — no new queries, fully unit-testable. Recommendations are suggestions,
// never mandates: each points at a concrete, observed signal so the developer can
// judge for itself.

export type Recommendation = {
  detail: string;
  id: string;
  severity: 'info' | 'warn';
  title: string;
};

export type RecommendationInputs = {
  cacheSummary: UserCacheSummaryRow;
  mcp: McpUsageRow[];
  modelRouting: UserModelRoutingRow[];
  /** Resolved policy per agent_type — the developer's own agents only. */
  policies: Map<string, ModelPolicySnapshot>;
  scoredSessionCount: number;
  sources: FrictionSources;
  toolPerf: ToolPerfRow[];
};

// Per-developer, per-tool coaching thresholds. Intentionally distinct from the
// org-wide alerting constants in @ai-agents-observability/schemas (ERROR_RATE_WARN
// 0.1 / ERROR_RATE_MIN_CALLS 100): those gate a noisy org-aggregate alert, whereas
// here a single developer's single tool needs a much lower call floor to be worth a
// hint, and a higher rate before it's notable for one person. A tool/server needs
// at least this many calls before its error rate is trusted (avoids coaching off a
// 1-of-1 fluke), and an error rate whose Wilson lower bound sits at/above this warns.
const MIN_TOOL_CALLS = 5;
const TOOL_ERROR_RATE_WARN = 0.2;
// A friction driver contributing at least this much (weighted) is worth surfacing.
const SOURCE_FLOOR = 0.05;

// Evidence floors for the routing/cache/denial hints — a single denial or a
// handful of tokens is noise, not a coaching signal.
const MIN_PERMISSION_DENIALS = 2;
const MIN_CACHE_SESSIONS = 3;
const MIN_CACHE_INPUT_TOKENS = 100_000n;
const CACHE_HIT_LOW = 0.2;

function topSource(s: FrictionSources): keyof FrictionSources {
  const keys = ['denial', 'error', 'interrupt', 'abandonment'] as const;
  return keys.reduce<keyof FrictionSources>((best, k) => (s[k] > s[best] ? k : best), 'denial');
}

// Wilson lower-bound for a binomial proportion (95% confidence). We use this as
// a simple confidence gate so low-sample rows don't look "high-error" by fluke.
function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  if (trials <= 0) {
    return 0;
  }
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const radius = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (center - radius) / denom);
}

function buildRoutingRecommendation(
  rows: UserModelRoutingRow[],
  policies: Map<string, ModelPolicySnapshot>,
): Recommendation[] {
  // Keyed by (agent, model): the same model id under two agents prices from two
  // different tables, so they must never be summed together.
  // Spend is `number | null` throughout: the rows carry the P14-005 attributed
  // cost, which is NULL wherever the events have no turn linkage. Adding with
  // `addNullable` keeps that null from turning into a $0 that would read as
  // "this model costs nothing on retrieval" and suppress the very hint this
  // function exists to raise.
  const byModel = new Map<
    string,
    {
      agentType: string;
      cheapCalls: number;
      cheapSpend: number | null;
      model: string;
      totalSpend: number | null;
    }
  >();
  for (const row of rows) {
    const policy = policies.get(row.agentType);
    if (!policy) {
      continue;
    }
    const key = `${row.agentType}:${row.model}`;
    const agg = byModel.get(key) ?? {
      agentType: row.agentType,
      cheapCalls: 0,
      cheapSpend: null,
      model: row.model,
      totalSpend: null,
    };
    agg.totalSpend = addNullable(agg.totalSpend, row.attributedCostUsd);
    if (isCheapCategory(policy, row.toolCategory)) {
      agg.cheapCalls += row.callCount;
      agg.cheapSpend = addNullable(agg.cheapSpend, row.attributedCostUsd);
    }
    byModel.set(key, agg);
  }

  const candidates = [...byModel.values()]
    .filter(
      (agg) =>
        agg.cheapCalls >= MIN_ROUTING_CHEAP_CALLS &&
        agg.cheapSpend !== null &&
        agg.cheapSpend >= MIN_ROUTING_CHEAP_SPEND_USD,
    )
    .flatMap((agg) => {
      const cheapSpend = agg.cheapSpend;
      const totalSpend = agg.totalSpend;
      // Re-asserted for the type checker; the filter above already dropped it.
      if (cheapSpend === null) {
        return [];
      }
      const policy = policies.get(agg.agentType);
      const savings = policy ? estimateRoutingSavings(policy, agg.model) : null;
      // No price entry, or nothing cheaper to route to → no tip, never a
      // fabricated number.
      if (!savings || savings.high < MIN_SAVINGS_RATIO) {
        return [];
      }
      return [
        {
          ...agg,
          cheapShare: totalSpend !== null && totalSpend > 0 ? cheapSpend / totalSpend : 0,
          savingHigh: cheapSpend * savings.high,
          savingLow: cheapSpend * savings.low,
          target: savings.bestTargetModel,
        },
      ];
    })
    .sort((a, b) => b.savingHigh - a.savingHigh);

  const top = candidates[0];
  if (!top) {
    return [];
  }

  return [
    {
      detail: `${top.model} handled ${top.cheapCalls} retrieval calls (reads/search), about ${(top.cheapShare * 100).toFixed(0)}% of that model's spend. Routing that segment to a cheaper model such as ${top.target} would likely save $${top.savingLow.toFixed(2)}–$${top.savingHigh.toFixed(2)} over this period.`,
      id: `routing:${top.model}`,
      severity: top.cheapShare >= 0.6 ? 'warn' : 'info',
      title: `Cheaper model would likely cover this retrieval work (${top.model})`,
    },
  ];
}

function buildCacheRecommendation(cache: UserCacheSummaryRow): Recommendation[] {
  if (cache.sessionCount < MIN_CACHE_SESSIONS || cache.totalInputTokens < MIN_CACHE_INPUT_TOKENS) {
    return [];
  }
  const denom = cache.totalInputTokens + cache.totalCacheReadTokens;
  const cacheHit = denom > 0n ? Number(cache.totalCacheReadTokens) / Number(denom) : 0;
  if (cacheHit >= CACHE_HIT_LOW) {
    return [];
  }

  return [
    {
      detail: `Cache read share is ${(cacheHit * 100).toFixed(1)}% over ${cache.sessionCount} sessions. Reusing long-running sessions and keeping stable context usually improves cache reuse and lowers cost.`,
      id: 'cache-efficiency',
      severity: 'info',
      title: 'Low cache reuse in recent sessions',
    },
  ];
}

export function buildRecommendations(input: RecommendationInputs): Recommendation[] {
  const { cacheSummary, mcp, modelRouting, policies, scoredSessionCount, sources, toolPerf } =
    input;
  // No scored sessions → nothing trustworthy to coach on.
  if (scoredSessionCount === 0) {
    return [];
  }

  const recs: Recommendation[] = [];
  const dominant = topSource(sources);

  // 1. Permission denials — pre-approving routine tools cuts interruptions.
  const denied = toolPerf
    .filter((t) => t.deniedCount > 0)
    .sort((a, b) => b.deniedCount - a.deniedCount);
  if (denied.length > 0) {
    const totalDenied = denied.reduce((sum, t) => sum + t.deniedCount, 0);
    if (totalDenied >= MIN_PERMISSION_DENIALS) {
      const names = denied.slice(0, 3).map((t) => t.toolName);
      recs.push({
        detail: `${totalDenied} permission prompt${totalDenied === 1 ? '' : 's'} were denied across ${names.join(', ')}. If these are routine, allow them in your settings to cut interruptions.`,
        id: 'permission-denials',
        severity: dominant === 'denial' ? 'warn' : 'info',
        title: 'Pre-approve frequently denied tools',
      });
    }
  }

  // 2. Error-prone tools — high failure rate means retries and wasted spend.
  const errorProne = toolPerf
    .filter((t) => t.callCount >= MIN_TOOL_CALLS)
    .filter((t) => wilsonLowerBound(t.errorCount, t.callCount) >= TOOL_ERROR_RATE_WARN)
    .sort((a, b) => b.errorCount / b.callCount - a.errorCount / a.callCount);
  for (const t of errorProne.slice(0, 3)) {
    const rate = Math.round((t.errorCount / t.callCount) * 100);
    recs.push({
      detail: `${t.toolName} failed ${rate}% of ${t.callCount} calls. Review its arguments, documentation, or environment to reduce retries.`,
      id: `tool-errors:${t.toolName}`,
      severity: 'warn',
      title: `High error rate on ${t.toolName}`,
    });
  }

  // 3. Flaky MCP servers — aggregate tool rows up to the server.
  const byServer = new Map<string, { calls: number; errors: number }>();
  for (const row of mcp) {
    const agg = byServer.get(row.mcpServer) ?? { calls: 0, errors: 0 };
    agg.calls += row.callCount;
    agg.errors += row.errorCount;
    byServer.set(row.mcpServer, agg);
  }
  const flakyServers = [...byServer.entries()]
    .filter(([, a]) => a.calls >= MIN_TOOL_CALLS)
    .filter(([, a]) => wilsonLowerBound(a.errors, a.calls) >= TOOL_ERROR_RATE_WARN)
    .sort((a, b) => b[1].errors / b[1].calls - a[1].errors / a[1].calls);
  for (const [server, a] of flakyServers.slice(0, 3)) {
    const rate = Math.round((a.errors / a.calls) * 100);
    recs.push({
      detail: `The ${server} MCP server errored on ${rate}% of ${a.calls} calls. Check its health, auth, or version — a flaky server slows every session that uses it.`,
      id: `mcp-errors:${server}`,
      severity: 'warn',
      title: `${server} MCP server is erroring`,
    });
  }

  // 4. Premium model doing retrieval work, and 5. poor cache reuse — the two
  // cost-shaped hints. Both gate on their own evidence floors above.
  recs.push(...buildRoutingRecommendation(modelRouting, policies));
  recs.push(...buildCacheRecommendation(cacheSummary));

  // 6. Interrupts are the dominant driver — usually a prompt-clarity signal.
  if (dominant === 'interrupt' && sources.interrupt >= SOURCE_FLOOR) {
    recs.push({
      detail:
        'Interruptions are your largest friction source. A more specific upfront prompt — or a planning step before edits — tends to cut mid-task corrections.',
      id: 'interrupts',
      severity: 'info',
      title: 'Interruptions drive most of your friction',
    });
  }

  // 7. Early abandonment — sessions dropped within a minute.
  if (sources.abandonment >= SOURCE_FLOOR) {
    recs.push({
      detail:
        'Several sessions were abandoned within a minute of starting. Opening with a concrete, well-scoped goal helps sessions get traction.',
      id: 'abandonment',
      severity: 'info',
      title: 'Sessions are being abandoned early',
    });
  }

  // Warnings first, then info; stable within each tier (insertion order).
  return recs.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
}
