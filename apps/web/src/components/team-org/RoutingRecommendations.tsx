import { agentDisplayName } from '@ai-agents-observability/schemas';
import { Card, EmptyState } from '@/components/ui';
import { fmtUsd } from '@/lib/fmt';
import type { RegisteredProjection } from '@/lib/projections';
import type { RoutingRecommendation } from '@/lib/routing-queries';

/**
 * Presentational only — the page resolves each agent's policy and computes
 * recommendations via computeRoutingRecommendations (routing-queries.ts), then
 * passes them in. Copy here is deliberately hedged: savings are a range derived
 * from each agent's live price table, not a guarantee (DESIGN_DOC §10.6
 * effectiveness-estimate discipline).
 *
 * P13-006: the saving is rendered from a `RegisteredProjection`, not from the
 * recommendation. That type can only be produced by `recordProjection(s)`, which
 * persists, so this component *cannot* display a claim that was not registered —
 * the enforcement is the prop type, not a review convention. It also means the
 * numbers on screen and the numbers in the registry are the same numbers, rather
 * than two computations that can drift.
 *
 * Tiers are policy-derived per agent (packages/schemas `model-policy.ts`), so
 * nothing here names a vendor or a model family: the current tier, the target
 * tier and the example target model all come off the recommendation.
 */

export type RegisteredRoutingClaim = {
  projection: RegisteredProjection;
  /**
   * Every (agent, model) recommendation this claim covers — normally one. A
   * claim is registered per model because that is the granularity the actuals
   * query can measure, so two agents routing the same model id share one claim.
   */
  recommendations: RoutingRecommendation[];
};

export type RoutingRecommendationsProps = {
  claims: RegisteredRoutingClaim[];
  /** Material retrieval spend on models the agent's price table could not price. */
  unpricedModels: { agentType: string; model: string }[];
};

export function RoutingRecommendations({ claims, unpricedModels }: RoutingRecommendationsProps) {
  // Totals are summed from the registered ranges, so the headline and the rows
  // cannot disagree, and the headline is a range for the same reason each row is.
  const totalLow = claims.reduce((sum, c) => sum + c.projection.projectedLow, 0);
  const totalHigh = claims.reduce((sum, c) => sum + c.projection.projectedHigh, 0);

  return (
    <div className="space-y-3">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
        Routing recommendations
      </h2>

      {claims.length === 0 ? (
        <EmptyState>
          No downgradeable model spend on retrieval-only tool categories in this period — routing
          already looks efficient.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-text-2">
            Estimated{' '}
            <span className="font-mono font-semibold text-good">
              {fmtUsd(totalLow)}–{fmtUsd(totalHigh)} / mo
            </span>{' '}
            by routing retrieval-only turns to a cheaper model. The spread is which model in the
            target tier you route to, not uncertainty about the rates.
          </p>

          {claims.map(({ projection, recommendations }) => (
            // `projection.segment` is the model id by construction — the page
            // registers one claim per model so the actuals query can measure it.
            <Card key={projection.id} className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium text-text">
                  <span className="font-mono text-warn">{projection.segment}</span>
                  {' — '}
                  {fmtUsd(recommendations.reduce((s, r) => s + r.cheapCategorySpend, 0))} spent on
                  retrieval-only categories this window
                </p>
                {recommendations.map((rec) => (
                  <div key={rec.agentType}>
                    <p className="text-xs text-text-3">
                      {agentDisplayName(rec.agentType)} · {rec.tier} tier ·{' '}
                      {rec.cheapCategoryCalls.toLocaleString()} retrieval calls · confidence{' '}
                      {rec.confidence}
                    </p>
                    <p className="text-xs text-text-2">
                      Route these turns to the {rec.targetTier} tier — e.g.{' '}
                      <span className="font-mono">{rec.exampleTargetModel}</span>
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs text-text-2">
                      {rec.topCategories.map((c) => (
                        <li key={c.category}>
                          <span className="font-mono">{c.category}</span> —{' '}
                          {c.callCount.toLocaleString()} calls, {fmtUsd(c.costUsd)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="flex-shrink-0 text-right">
                <p className="text-xs uppercase tracking-wider text-text-3">Est. monthly saving</p>
                <p className="text-lg font-semibold font-mono text-good">
                  {fmtUsd(projection.projectedLow)}–{fmtUsd(projection.projectedHigh)}
                </p>
              </div>
            </Card>
          ))}

          <p className="text-[11px] text-text-3">
            Ranges are derived per-agent from that agent's current price table: the low end assumes
            the dearest model in the target tier, the high end the cheapest. Still directional —
            real savings depend on the routed model handling the task. Each estimate above is
            recorded as a projection when it is shown, and checked against what actually happened in
            the panel below.
          </p>
        </div>
      )}

      {unpricedModels.length > 0 && (
        <Card
          caption="Material retrieval spend we could not price, so no recommendation was made"
          contentClassName="text-xs text-text-2"
          title="Unpriced models"
        >
          <ul className="space-y-0.5">
            {unpricedModels.map((u) => (
              <li key={`${u.agentType}:${u.model}`}>
                <span className="font-mono">{u.model}</span>{' '}
                <span className="text-text-3">({agentDisplayName(u.agentType)})</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
