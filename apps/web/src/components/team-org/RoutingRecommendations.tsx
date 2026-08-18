import { agentDisplayName } from '@ai-agents-observability/schemas';
import { Card, EmptyState } from '@/components/ui';
import { fmtUsd } from '@/lib/fmt';
import type { RoutingRecommendation } from '@/lib/routing-queries';

// Presentational only — the page resolves each agent's policy and computes
// recommendations via computeRoutingRecommendations (routing-queries.ts), then
// passes them in. Copy here is deliberately hedged: savings are a range derived
// from the live price table, not a guarantee (DESIGN_DOC §10.6
// effectiveness-estimate discipline).

export type RoutingRecommendationsProps = {
  estimatedMonthlySavingHigh: number;
  estimatedMonthlySavingLow: number;
  recommendations: RoutingRecommendation[];
  /** Material retrieval spend on models the price table could not price. */
  unpricedModels: { agentType: string; model: string }[];
};

export function RoutingRecommendations({
  estimatedMonthlySavingHigh,
  estimatedMonthlySavingLow,
  recommendations,
  unpricedModels,
}: RoutingRecommendationsProps) {
  return (
    <div className="space-y-3">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
        Routing recommendations
      </h2>

      {recommendations.length === 0 ? (
        <EmptyState>
          No downgradeable model spend on retrieval-only tool categories in this period — routing
          already looks efficient.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-text-2">
            Estimated{' '}
            <span className="font-mono font-semibold text-good">
              {fmtUsd(estimatedMonthlySavingLow)}–{fmtUsd(estimatedMonthlySavingHigh)} / mo
            </span>{' '}
            by routing retrieval-only turns to a cheaper model. The spread is which model you route
            to, not uncertainty about the rates.
          </p>

          {recommendations.map((rec) => (
            <Card
              key={`${rec.agentType}:${rec.model}`}
              className="flex flex-wrap items-start gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">
                  <span className="font-mono text-warn">{rec.model}</span>
                  {' — '}
                  {fmtUsd(rec.cheapCategorySpend)} spent on retrieval-only categories this window
                </p>
                <p className="mt-0.5 text-xs text-text-3">
                  {agentDisplayName(rec.agentType)} · {rec.tier} tier ·{' '}
                  {rec.cheapCategoryCalls.toLocaleString()} retrieval calls · confidence{' '}
                  {rec.confidence}
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
              <div className="flex-shrink-0 text-right">
                <p className="text-xs uppercase tracking-wider text-text-3">Est. monthly saving</p>
                <p className="text-lg font-semibold font-mono text-good">
                  {fmtUsd(rec.monthlySavingLow)}–{fmtUsd(rec.monthlySavingHigh)}
                </p>
                <p className="text-[10px] text-text-3">
                  routed to the {rec.targetTier} tier, e.g.{' '}
                  <span className="font-mono">{rec.exampleTargetModel}</span>
                </p>
              </div>
            </Card>
          ))}

          <p className="text-[11px] text-text-3">
            Ranges are derived per-agent from the current ingest price table: the low end assumes
            the dearest model in the target tier, the high end the cheapest. Still directional —
            real savings depend on the routed model handling the task, so pair this with the
            validation panel below rather than banking it.
          </p>
        </div>
      )}

      {unpricedModels.length > 0 && (
        <Card
          title="Unpriced models"
          caption="Material retrieval spend we could not price, so no recommendation was made"
        >
          <ul className="space-y-0.5 text-xs text-text-2">
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
