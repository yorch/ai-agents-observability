import { Cell, EmptyState, Row, Table } from '@/components/ui';
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
        spending downgradeable-model budget on retrieval-only work (file reads, search) so leads can
        follow up; pair it with the <span className="font-mono text-text-2">routing_waste</span>{' '}
        alert for proactive notice.
      </p>

      {rows.length === 0 ? (
        <EmptyState>
          No team has premium-model spend on retrieval-only tool categories in this period.
        </EmptyState>
      ) : (
        <Table
          columns={[
            { label: 'Team' },
            { align: 'right', label: 'Retrieval spend' },
            { align: 'right', label: 'Total on those models' },
            { align: 'right', label: 'Share' },
          ]}
        >
          {rows.map((r) => {
            const share = r.premiumTotalUsd > 0 ? r.premiumRetrievalUsd / r.premiumTotalUsd : 0;
            const highShare = share > HIGH_SHARE_THRESHOLD;
            return (
              <Row key={r.teamSlug}>
                <Cell className="text-text">{r.teamName}</Cell>
                <Cell num className="text-text">
                  {fmtUsd(r.premiumRetrievalUsd)}
                </Cell>
                <Cell num className="text-text-2">
                  {fmtUsd(r.premiumTotalUsd)}
                </Cell>
                <Cell
                  num
                  className={`px-4 py-3 text-right font-mono font-medium ${highShare ? 'text-warn' : 'text-text-2'}`}
                >
                  {(share * 100).toFixed(0)}%
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}
    </div>
  );
}
