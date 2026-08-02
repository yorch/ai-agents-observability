import { Card, Cell, Row, Table } from '@/components/ui';
import type { TeamPrRollupRow } from '@/lib/team-queries';

export function TeamPrRollupTable({ rows }: { rows: TeamPrRollupRow[] }) {
  if (rows.length === 0) {
    return (
      <Card title="Merged PRs" contentClassName="space-y-3">
        <p className="text-sm text-text-3">No merged PRs in this period.</p>
      </Card>
    );
  }

  return (
    <Card title="Merged PRs" contentClassName="space-y-3">
      <Table
        columns={[
          { label: 'PR' },
          { label: 'Title' },
          { label: 'Author' },
          { label: 'Merged' },
          { label: 'Cost' },
          { align: 'right', label: 'Sessions' },
          { align: 'right', label: 'Time to merge' },
        ]}
      >
        {rows.map((row) => (
          <Row key={`${row.repoOwner}/${row.repoName}/${row.prNumber}`}>
            <Cell>
              <a
                href={`https://github.com/${row.repoOwner}/${row.repoName}/pull/${row.prNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline font-mono text-xs"
              >
                #{row.prNumber}
              </a>
            </Cell>
            <Cell className="text-text-2 truncate max-w-xs">{row.title || '(untitled)'}</Cell>
            <Cell className="text-text-2 text-xs">{row.authorGithubLogin}</Cell>
            <Cell className="text-text-2 text-xs">{row.mergedAt.toLocaleDateString()}</Cell>
            <Cell>
              <div className="inline-flex rounded-full bg-surface-2 px-2 py-0.5 font-mono text-xs text-text-2">
                ${row.totalCostUsd.toFixed(2)}
              </div>
            </Cell>
            <Cell num className="text-text-2 text-xs">
              {row.sessionCount}
            </Cell>
            <Cell num className="text-text-2 text-xs">
              {row.timeToMergeHours !== null ? `${row.timeToMergeHours.toFixed(1)}h` : '—'}
            </Cell>
          </Row>
        ))}
      </Table>
    </Card>
  );
}
