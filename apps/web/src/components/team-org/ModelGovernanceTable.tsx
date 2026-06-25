import type { TeamModelGovernanceRow } from '@/lib/org-queries';

export function ModelGovernanceTable({ rows }: { rows: TeamModelGovernanceRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Model governance by team</h2>
        <p className="text-sm text-white/40">No data available.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-white/70">Model governance by team</h2>
      <p className="text-xs text-white/40">Top model by cost per team (top 10 teams).</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-white/40 text-left">
              <th className="pb-2 font-semibold">Team</th>
              <th className="pb-2 font-semibold">Top Model</th>
              <th className="pb-2 font-semibold">Model Cost %</th>
              <th className="pb-2 font-semibold text-right">Total Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((row) => (
              <tr key={row.teamSlug} className="hover:bg-white/2">
                <td className="py-3 pr-4 text-white">{row.teamName}</td>
                <td className="py-3 pr-4 font-mono text-xs text-white/60">{row.topModel}</td>
                <td className="py-3 pr-4 text-white/60 text-xs text-right">
                  {row.modelCostPct.toFixed(0)}%
                </td>
                <td className="py-3 font-mono text-xs text-white/60 text-right">
                  ${row.totalCostUsd.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
