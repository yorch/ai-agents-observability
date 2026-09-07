import { Card, EmptyState } from '@/components/ui';
import { fmtPct, fmtUsd } from '@/lib/fmt';
import type { RegisteredProjection } from '@/lib/projections';
import type { RoutingRecommendation } from '@/lib/routing-queries';

/**
 * Presentational only — the page computes recommendations via
 * computeRoutingRecommendations (routing-queries.ts) and passes them in.
 * Copy here is deliberately hedged: this is a directional estimate, not a
 * guarantee (DESIGN_DOC §10.6 effectiveness-estimate discipline).
 *
 * P13-006: the saving is rendered from a `RegisteredProjection`, not from the
 * recommendation. That type can only be produced by `recordProjection(s)`, which
 * persists, so this component *cannot* display a claim that was not registered —
 * the enforcement is the prop type, not a review convention. It also means the
 * numbers on screen and the numbers in the registry are the same numbers, rather
 * than two computations that can drift.
 */

export type RegisteredRoutingClaim = {
  projection: RegisteredProjection;
  recommendation: RoutingRecommendation;
};

export type RoutingRecommendationsProps = {
  claims: RegisteredRoutingClaim[];
  // Whether the ingest price table was reachable at all (INGEST_URL set, fetch
  // succeeded, table non-empty). Whether any GIVEN row's ratio came from it is a
  // separate, per-model question — `recommendation.priceDerived` — because a model
  // absent from the table falls back to the flat heuristic even when the fetch
  // worked. The copy below distinguishes all / some / none rather than asserting
  // per-model pricing for every row on the strength of the fetch succeeding.
  priceTableReachable: boolean;
};

export function RoutingRecommendations({
  claims,
  priceTableReachable,
}: RoutingRecommendationsProps) {
  // Totals are summed from the registered ranges, so the headline and the rows
  // cannot disagree, and the headline is a range for the same reason each row is.
  const totalLow = claims.reduce((sum, c) => sum + c.projection.projectedLow, 0);
  const totalHigh = claims.reduce((sum, c) => sum + c.projection.projectedHigh, 0);

  // Count the rows whose ratio actually came from the table, so the caveat
  // describes what happened rather than what was attempted.
  const derived = claims.filter((c) => c.recommendation.priceDerived).length;
  const provenanceCopy = !priceTableReachable
    ? 'INGEST_URL is not set, so every estimate here uses a flat ~90%-cheaper heuristic. Point the web app at ingest to derive per-model savings from the live price table.'
    : derived === claims.length
      ? 'Saving fractions are derived per-model from the current ingest price table (retrieval turns priced at the cheapest Haiku-class input rate). Still directional — real savings depend on the routed model handling the task.'
      : derived === 0
        ? 'None of these models appear in the current ingest price table, so every estimate here uses a flat ~90%-cheaper heuristic rather than a derived rate.'
        : `${derived} of ${claims.length} estimates are derived per-model from the current ingest price table; the rest use a flat ~90%-cheaper heuristic because those models are not in it.`;

  return (
    <div className="space-y-3">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
        Routing recommendations
      </h2>

      {claims.length === 0 ? (
        <EmptyState>
          No premium-model spend on retrieval-only tool categories in this period — routing already
          looks efficient.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-text-2">
            Estimated{' '}
            <span className="font-mono font-semibold text-good">
              {fmtUsd(totalLow)} – {fmtUsd(totalHigh)} / mo
            </span>{' '}
            by routing retrieval-only turns to a cheaper model.
          </p>

          {claims.map(({ projection, recommendation: rec }) => (
            <Card key={rec.model} className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">
                  <span className="font-mono text-warn">{rec.model}</span>
                  {' — '}
                  {fmtUsd(rec.cheapCategorySpend)} spent on retrieval-only categories this window
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
                  {fmtUsd(projection.projectedLow)} – {fmtUsd(projection.projectedHigh)}
                </p>
                <p className="text-[10px] text-text-3">
                  up to ~{fmtPct(rec.savingsRatio)} cheaper if routed to Haiku
                </p>
              </div>
            </Card>
          ))}

          <p className="text-[11px] text-text-3">
            {provenanceCopy} Each estimate above is recorded as a projection when it is shown, and
            checked against what actually happened in the panel below.
          </p>
        </div>
      )}
    </div>
  );
}
