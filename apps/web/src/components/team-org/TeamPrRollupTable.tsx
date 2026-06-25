import type { TeamPrRollupRow } from '@/lib/team-queries';

export function TeamPrRollupTable({ rows }: { rows: TeamPrRollupRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white/70">Merged PRs</h2>
        <p className="text-sm text-white/40">No merged PRs in this period.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-white/70">Merged PRs</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-white/40 text-left">
              <th className="pb-2 font-semibold">PR</th>
              <th className="pb-2 font-semibold">Title</th>
              <th className="pb-2 font-semibold">Author</th>
              <th className="pb-2 font-semibold">Merged</th>
              <th className="pb-2 font-semibold">Cost</th>
              <th className="pb-2 font-semibold">Sessions</th>
              <th className="pb-2 font-semibold text-right">Time to merge</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((row) => (
              <tr
                key={`${row.repoOwner}/${row.repoName}/${row.prNumber}`}
                className="hover:bg-white/2"
              >
                <td className="py-3 pr-4">
                  <a
                    href={`https://github.com/${row.repoOwner}/${row.repoName}/pull/${row.prNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-400 hover:underline font-mono text-xs"
                  >
                    #{row.prNumber}
                  </a>
                </td>
                <td className="py-3 pr-4 text-white/60 truncate max-w-xs">
                  {row.title || '(untitled)'}
                </td>
                <td className="py-3 pr-4 text-white/60 text-xs font-mono">
                  {row.authorGithubLogin}
                </td>
                <td className="py-3 pr-4 text-white/60 text-xs">
                  {row.mergedAt.toLocaleDateString()}
                </td>
                <td className="py-3 pr-4">
                  <div className="inline-flex rounded-full bg-white/10 px-2 py-0.5 font-mono text-xs text-white/60">
                    ${row.totalCostUsd.toFixed(2)}
                  </div>
                </td>
                <td className="py-3 pr-4 text-white/60 text-xs text-right">{row.sessionCount}</td>
                <td className="py-3 text-white/60 text-xs text-right">
                  {row.timeToMergeHours !== null ? `${row.timeToMergeHours.toFixed(1)}h` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
