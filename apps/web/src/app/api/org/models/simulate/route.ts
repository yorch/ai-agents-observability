import { type ModelPolicySnapshot, simulateRouting } from '@ai-agents-observability/schemas';
import type { NextRequest } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { getModelPolicies } from '@/lib/model-policy';
import { getOrgModelRoutingBreakdown } from '@/lib/org-queries';
import { requireOrgViewer } from '@/lib/roles';
import { sumRoutingSpend } from '@/lib/routing-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

// C4: Model routing simulation API. Given a source model, a target model, an
// agent type, a traffic share, and a lookback range, returns the projected
// savings from routing that fraction of the source model's retrieval spend to
// the target model. The math is the pure `simulateRouting` function from
// packages/schemas; this route resolves the policy and the observed spend.
export const GET = withRouteLogging('org.models.simulate', async (req: NextRequest) => {
  await requireOrgViewer();

  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const agentType = params.agent;
  const sourceModel = params.from;
  const targetModel = params.to;
  const trafficShare = Number(params.share ?? 0.5);
  const range = ([7, 30, 90].includes(Number(params.range)) ? Number(params.range) : 30) as
    | 7
    | 30
    | 90;

  if (!agentType || !sourceModel || !targetModel) {
    return Response.json({ error: 'Missing agent, from, or to parameter' }, { status: 400 });
  }
  if (!Number.isFinite(trafficShare) || trafficShare <= 0 || trafficShare > 1) {
    return Response.json({ error: 'share must be a number between 0 and 1' }, { status: 400 });
  }

  const since = daysAgo(range);
  const routing = await getOrgModelRoutingBreakdown(since);
  const policies = await getModelPolicies([agentType]);
  const policy: ModelPolicySnapshot | undefined = policies.get(agentType);
  if (!policy) {
    return Response.json({ error: 'No price table for this agent' }, { status: 404 });
  }

  // Sum the source model's retrieval-category spend (the spend that could be
  // rerouted). Only cheap categories count — routing non-retrieval work to a
  // cheaper model is not what the simulator is about. `spendUsd` is null when
  // no rows carry attribution — the simulator cannot run without it.
  const { callCount: sourceCallCount, spendUsd: sourceSpendUsd } = sumRoutingSpend(
    routing,
    agentType,
    sourceModel,
    policy.cheapCategories,
  );

  if (sourceSpendUsd === null) {
    return Response.json({
      eligible: false,
      message:
        'No attributed retrieval spend for this model in the selected window — the agent may not report turn linkage.',
      sourceCallCount,
    });
  }

  const result = simulateRouting(policy, sourceModel, targetModel, {
    sourceCallCount,
    sourceSpendUsd,
    trafficShare,
  });

  if (!result) {
    return Response.json({
      eligible: false,
      message: 'Target model is not cheaper than the source, or one of them is unpriced.',
      sourceCallCount,
      sourceSpendUsd,
    });
  }

  // Normalize to monthly, like the routing recommendations do.
  const toMonthly = range > 0 ? 30 / range : 0;
  return Response.json({
    eligible: true,
    rangeDays: range,
    result: {
      ...result,
      estimatedMonthlySavingUsd: result.estimatedSavingUsd * toMonthly,
      sourceCallCount,
      sourceSpendUsd,
      trafficShare,
    },
  });
});
