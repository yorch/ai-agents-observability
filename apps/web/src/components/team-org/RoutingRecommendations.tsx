import { fmtUsd } from '@/lib/fmt';
import type { RoutingRecommendation } from '@/lib/routing-queries';

// Presentational only — the page computes recommendations via
// computeRoutingRecommendations (routing-queries.ts) and passes them in.
// Copy here is deliberately hedged: this is a directional estimate, not a
// guarantee (DESIGN_DOC §10.6 effectiveness-estimate discipline).

export type RoutingRecommendationsProps = {
  estimatedMonthlySaving: number;
  // True when the saving fraction came from the ingest price table (per-model),
  // false when it fell back to the flat heuristic (INGEST_URL unset / fetch failed).
  pricePrecise: boolean;
  recommendations: RoutingRecommendation[];
};

export function RoutingRecommendations({
  estimatedMonthlySaving,
  pricePrecise,
  recommendations,
}: RoutingRecommendationsProps) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">
        Routing recommendations
      </h2>

      {recommendations.length === 0 ? (
        <p className="rounded-lg border border-white/10 bg-white/5 p-4 text-xs text-white/50">
          No premium-model spend on retrieval-only tool categories in this window — routing already
          looks efficient.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-white/50">
            Estimated up to{' '}
            <span className="font-mono font-semibold text-emerald-400">
              {fmtUsd(estimatedMonthlySaving)} / mo
            </span>{' '}
            by routing retrieval-only turns to a cheaper model.
          </p>

          {recommendations.map((rec) => (
            <div
              key={rec.model}
              className="flex flex-wrap items-start gap-4 rounded-lg border border-white/10 bg-white/5 p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white/90">
                  <span className="font-mono text-amber-300">{rec.model}</span>
                  {' — '}
                  {fmtUsd(rec.cheapCategorySpend)} spent on retrieval-only categories this window
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-white/50">
                  {rec.topCategories.map((c) => (
                    <li key={c.category}>
                      <span className="font-mono">{c.category}</span> —{' '}
                      {c.callCount.toLocaleString()} calls, {fmtUsd(c.costUsd)}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex-shrink-0 text-right">
                <p className="text-xs uppercase tracking-wider text-white/40">
                  Est. monthly saving
                </p>
                <p className="text-lg font-semibold font-mono text-emerald-400">
                  {fmtUsd(rec.estimatedMonthlySaving)}
                </p>
                <p className="text-[10px] text-white/30">
                  ~{Math.round(rec.savingsRatio * 100)}% cheaper if routed to Haiku
                </p>
              </div>
            </div>
          ))}

          <p className="text-[11px] text-white/30">
            {pricePrecise
              ? 'Saving fractions are derived per-model from the current ingest price table (retrieval turns priced at the cheapest Haiku-class input rate). Still directional — real savings depend on the routed model handling the task.'
              : 'INGEST_URL is not set, so this uses a flat ~90%-cheaper heuristic. Point the web app at ingest to derive per-model savings from the live price table.'}
          </p>
        </div>
      )}
    </div>
  );
}
