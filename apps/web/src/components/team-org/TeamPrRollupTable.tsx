import { Card } from '@/components/ui';
import type { TeamPrRollupRow } from '@/lib/team-queries';

export function TeamPrRollupTable({ rows }: { rows: TeamPrRollupRow[] }) {
  if (rows.length === 0) {
    return (
      <Card className="space-y-3">
        <h2 className="font-display text-sm font-semibold text-text">Merged PRs</h2>
        <p className="text-sm text-text-3">No merged PRs in this period.</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-display text-sm font-semibold text-text">Merged PRs</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-3 text-left">
              <th className="pb-2 font-semibold">PR</th>
              <th className="pb-2 font-semibold">Title</th>
              <th className="pb-2 font-semibold">Author</th>
              <th className="pb-2 font-semibold">Merged</th>
              <th className="pb-2 font-semibold">Cost</th>
              <th className="pb-2 font-semibold">Sessions</th>
              <th className="pb-2 font-semibold text-right">Time to merge</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <tr
                key={`${row.repoOwner}/${row.repoName}/${row.prNumber}`}
                className="hover:bg-surface-2"
              >
                <td className="py-3 pr-4">
                  <a
                    href={`https://github.com/${row.repoOwner}/${row.repoName}/pull/${row.prNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline font-mono text-xs"
                  >
                    #{row.prNumber}
                  </a>
                </td>
                <td className="py-3 pr-4 text-text-2 truncate max-w-xs">
                  {row.title || '(untitled)'}
                </td>
                <td className="py-3 pr-4 text-text-2 text-xs font-mono">{row.authorGithubLogin}</td>
                <td className="py-3 pr-4 text-text-2 text-xs">
                  {row.mergedAt.toLocaleDateString()}
                </td>
                <td className="py-3 pr-4">
                  <div className="inline-flex rounded-full bg-surface-2 px-2 py-0.5 font-mono text-xs text-text-2">
                    ${row.totalCostUsd.toFixed(2)}
                  </div>
                </td>
                <td className="py-3 pr-4 text-text-2 text-xs text-right">{row.sessionCount}</td>
                <td className="py-3 text-text-2 text-xs text-right">
                  {row.timeToMergeHours !== null ? `${row.timeToMergeHours.toFixed(1)}h` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
