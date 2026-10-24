import { Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import type { TeamModelGovernanceRow } from '@/lib/org-queries';

export async function ModelGovernanceTable({ rows }: { rows: TeamModelGovernanceRow[] }) {
  const { dict } = await getTranslations();
  if (rows.length === 0) {
    return (
      <Card title={dict.org.modelGovernance.title} contentClassName="space-y-3">
        <CardEmpty>{dict.org.modelGovernance.empty}</CardEmpty>
      </Card>
    );
  }

  return (
    <Card title={dict.org.modelGovernance.title} contentClassName="space-y-3">
      <p className="text-xs text-text-3">{dict.org.modelGovernance.caption}</p>
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
