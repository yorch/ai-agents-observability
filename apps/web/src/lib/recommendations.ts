import type { FrictionSources } from './effectiveness-queries';
import type {
  McpUsageRow,
  ToolPerfRow,
  UserCacheSummaryRow,
  UserModelRoutingRow,
} from './insights-queries';
import {
  CHEAP_SUITABLE_CATEGORIES,
  HAIKU_SAVINGS_RATIO,
  MIN_ROUTING_CHEAP_CALLS,
  MIN_ROUTING_CHEAP_SPEND_USD,
  PREMIUM_PATTERN,
} from './routing-queries';

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

function buildRoutingRecommendation(rows: UserModelRoutingRow[]): Recommendation[] {
  const byModel = new Map<string, { cheapCalls: number; cheapSpend: number; totalSpend: number }>();
  for (const row of rows) {
    const agg = byModel.get(row.model) ?? { cheapCalls: 0, cheapSpend: 0, totalSpend: 0 };
    agg.totalSpend += row.totalCostUsd;
    if (CHEAP_SUITABLE_CATEGORIES.has(row.toolCategory)) {
      agg.cheapCalls += row.callCount;
      agg.cheapSpend += row.totalCostUsd;
    }
    byModel.set(row.model, agg);
  }

  const premiumRows = [...byModel.entries()]
    .filter(
      ([model, agg]) =>
        model.toLowerCase().includes(PREMIUM_PATTERN) &&
        agg.cheapCalls >= MIN_ROUTING_CHEAP_CALLS &&
        agg.cheapSpend >= MIN_ROUTING_CHEAP_SPEND_USD,
    )
    .map(([model, agg]) => ({
      cheapShare: agg.totalSpend > 0 ? agg.cheapSpend / agg.totalSpend : 0,
      model,
      monthlySavingEstimate: agg.cheapSpend * HAIKU_SAVINGS_RATIO,
      ...agg,
    }))
    .sort((a, b) => b.monthlySavingEstimate - a.monthlySavingEstimate);

  if (premiumRows.length === 0) {
    return [];
  }

  const top = premiumRows[0];
  if (!top) {
    return [];
  }

  return [
    {
      detail: `${top.model} handled ${top.cheapCalls} retrieval calls (reads/search), about ${(top.cheapShare * 100).toFixed(0)}% of that model's spend. Routing that segment to a cheaper model would likely save about $${top.monthlySavingEstimate.toFixed(2)} per 30-day period.`,
      id: `routing:${top.model}`,
      severity: top.cheapShare >= 0.6 ? 'warn' : 'info',
      title: `Premium model used for retrieval-heavy work (${top.model})`,
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
  const { cacheSummary, mcp, modelRouting, scoredSessionCount, sources, toolPerf } = input;
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
  recs.push(...buildRoutingRecommendation(modelRouting));
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
