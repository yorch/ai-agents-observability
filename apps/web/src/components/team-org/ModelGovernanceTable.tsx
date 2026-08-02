import { Card } from '@/components/ui';
import type { TeamModelGovernanceRow } from '@/lib/org-queries';

export function ModelGovernanceTable({ rows }: { rows: TeamModelGovernanceRow[] }) {
  if (rows.length === 0) {
    return (
      <Card title="Model governance by team" contentClassName="space-y-3">
        <p className="text-sm text-text-3">No data available.</p>
      </Card>
    );
  }

  return (
    <Card title="Model governance by team" contentClassName="space-y-3">
      <p className="text-xs text-text-3">Top model by cost per team (top 10 teams).</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-3 text-left">
              <th className="pb-2 font-semibold">Team</th>
              <th className="pb-2 font-semibold">Top Model</th>
              <th className="pb-2 font-semibold">Model Cost %</th>
              <th className="pb-2 font-semibold text-right">Total Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <tr key={row.teamSlug} className="hover:bg-surface-2">
                <td className="py-3 pr-4 text-text">{row.teamName}</td>
                <td className="py-3 pr-4 font-mono text-xs text-text-2">{row.topModel}</td>
                <td className="py-3 pr-4 text-text-2 text-xs text-right">
                  {row.modelCostPct.toFixed(0)}%
                </td>
                <td className="py-3 font-mono text-xs text-text-2 text-right">
                  ${row.totalCostUsd.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
