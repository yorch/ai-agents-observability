import { fmtUsd } from '@/lib/fmt';
import type { RoutingTeamRow } from '@/lib/org-queries';

// Presentational only — the page fetches getRoutingSpendByTeam and passes rows
// in. This is an accountability surface, not an enforcement one: the platform
// is observe-only (DESIGN_DOC §10.3a), so this table never blocks or reroutes
// a live call — it just tells leads who's burning premium-model spend on
// retrieval-only work so they can act. Pairs with the org-wide `routing_waste`
// alert, which fires on the aggregate total; this is the by-team breakdown.

// Flag a team's row when its retrieval spend is a high share of its total
// premium spend — same accent thresholds pattern as the page's other cards.
const HIGH_SHARE_THRESHOLD = 0.25;

export type RoutingByTeamProps = {
  rows: RoutingTeamRow[];
};

export function RoutingByTeam({ rows }: RoutingByTeamProps) {
  return (
    <div className="space-y-3">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
        Routing accountability by team
      </h2>
      <p className="text-xs text-text-2">
        Observe-only — the platform never blocks a live tool call. This surfaces which teams are
        spending premium-model (Opus) budget on retrieval-only work (file reads, search) so leads
        can follow up; pair it with the <span className="font-mono text-text-2">routing_waste</span>{' '}
        alert for proactive notice.
      </p>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-4 text-xs text-text-2">
          No team has premium-model spend on retrieval-only tool categories in this window.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-text-3">
                <th className="px-4 py-3 font-medium">Team</th>
                <th className="px-4 py-3 text-right font-medium">Retrieval spend (Opus)</th>
                <th className="px-4 py-3 text-right font-medium">Total Opus spend</th>
                <th className="px-4 py-3 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const share = r.premiumTotalUsd > 0 ? r.premiumRetrievalUsd / r.premiumTotalUsd : 0;
                const highShare = share > HIGH_SHARE_THRESHOLD;
                return (
                  <tr
                    key={r.teamSlug}
                    className="border-b border-border-subtle hover:bg-surface-2 transition-colors"
                  >
                    <td className="px-4 py-3 text-text">{r.teamName}</td>
                    <td className="px-4 py-3 text-right font-mono text-text font-medium">
                      {fmtUsd(r.premiumRetrievalUsd)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-text-2">
                      {fmtUsd(r.premiumTotalUsd)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono font-medium ${highShare ? 'text-warn' : 'text-text-2'}`}
                    >
                      {(share * 100).toFixed(0)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
