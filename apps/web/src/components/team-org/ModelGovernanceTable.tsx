import { Card, Cell, Row, Table } from '@/components/ui';
import type { TeamModelGovernanceRow } from '@/lib/org-queries';

export function ModelGovernanceTable({ rows }: { rows: TeamModelGovernanceRow[] }) {
  if (rows.length === 0) {
    return (
      <Card title="Model governance by team" contentClassName="space-y-3">
        <p className="py-6 text-center text-sm text-text-3">No model usage in this period.</p>
      </Card>
    );
  }

  return (
    <Card title="Model governance by team" contentClassName="space-y-3">
      <p className="text-xs text-text-3">Top model by cost per team (top 10 teams).</p>
      <Table
        columns={[
          { label: 'Team' },
          { label: 'Top Model' },
          { align: 'right', label: 'Model Cost %' },
          { align: 'right', label: 'Total Cost' },
        ]}
      >
        {rows.map((row) => (
          <Row key={row.teamSlug}>
            <Cell className="text-text">{row.teamName}</Cell>
            <Cell className="text-xs text-text-2">{row.topModel}</Cell>
            <Cell num className="text-text-2 text-xs">
              {row.modelCostPct.toFixed(0)}%
            </Cell>
            <Cell num className="text-xs text-text-2">
              ${row.totalCostUsd.toFixed(2)}
            </Cell>
          </Row>
        ))}
      </Table>
    </Card>
  );
}
