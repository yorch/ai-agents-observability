import { fmtDuration } from '@/lib/fmt';
import type { SubagentStatRow } from '@/lib/org-queries';

export function AgentsTable({
  agents,
  totalSpawns,
}: {
  agents: SubagentStatRow[];
  totalSpawns: number;
}) {
  const maxSpawns = Math.max(...agents.map((a) => a.spawnCount), 1);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-text-3">
            <th className="px-4 py-3 font-medium">Agent type</th>
            <th className="px-4 py-3 text-right font-medium">Spawns</th>
            <th className="px-4 py-3 text-right font-medium">Share</th>
            <th className="px-4 py-3 text-right font-medium">Users</th>
            <th className="px-4 py-3 text-right font-medium">Avg duration</th>
            <th className="px-4 py-3 text-right font-medium">Total cost</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const label = a.subagentType ?? '(untyped)';
            const sharePct = totalSpawns > 0 ? (a.spawnCount / totalSpawns) * 100 : 0;
            const barPct = (a.spawnCount / maxSpawns) * 100;
            return (
              <tr
                key={label}
                className="border-b border-border-subtle transition-colors hover:bg-surface-2"
              >
                <td className="px-4 py-3">
                  <div className="space-y-1.5">
                    <span
                      className={`font-mono text-text ${a.subagentType === null ? 'italic text-text-3' : ''}`}
                    >
                      {label}
                    </span>
                    <div className="h-1 w-40 rounded-full bg-surface">
                      <div
                        className="h-full rounded-full bg-series-6/50"
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono font-medium text-text">
                  {a.spawnCount.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right text-text-2">{sharePct.toFixed(1)}%</td>
                <td className="px-4 py-3 text-right text-text-2">
                  {a.distinctUsers.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-mono text-text-2">
                  {a.avgDurationMs !== null ? fmtDuration(a.avgDurationMs) : '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono text-text-2">
                  {a.totalCostUsd > 0 ? `$${a.totalCostUsd.toFixed(3)}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
