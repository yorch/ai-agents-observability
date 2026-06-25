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
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/10 text-left text-white/30">
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
                className="border-b border-white/5 transition-colors hover:bg-white/5"
              >
                <td className="px-4 py-3">
                  <div className="space-y-1.5">
                    <span
                      className={`font-mono text-white/80 ${a.subagentType === null ? 'italic text-white/40' : ''}`}
                    >
                      {label}
                    </span>
                    <div className="h-1 w-40 rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-pink-500/50"
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono font-medium text-white/80">
                  {a.spawnCount.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right text-white/50">{sharePct.toFixed(1)}%</td>
                <td className="px-4 py-3 text-right text-white/50">
                  {a.distinctUsers.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-mono text-white/50">
                  {a.avgDurationMs !== null ? fmtDuration(a.avgDurationMs) : '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono text-white/50">
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
