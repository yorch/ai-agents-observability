import { Card, Cell, Row, Table } from '@/components/ui';
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
    <Card>
      <Table
        columns={[
          { label: 'Agent type' },
          { align: 'right', label: 'Spawns' },
          { align: 'right', label: 'Share' },
          { align: 'right', label: 'Users' },
          { align: 'right', label: 'Avg duration' },
          { align: 'right', label: 'Total cost' },
        ]}
      >
        {agents.map((a) => {
          const label = a.subagentType ?? '(untyped)';
          const sharePct = totalSpawns > 0 ? (a.spawnCount / totalSpawns) * 100 : 0;
          const barPct = (a.spawnCount / maxSpawns) * 100;
          return (
            <Row key={label}>
              <Cell>
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
              </Cell>
              <Cell num className="font-medium text-text">
                {a.spawnCount.toLocaleString()}
              </Cell>
              <Cell num className="text-text-2">
                {sharePct.toFixed(1)}%
              </Cell>
              <Cell num className="text-text-2">
                {a.distinctUsers.toLocaleString()}
              </Cell>
              <Cell num className="text-text-2">
                {a.avgDurationMs !== null ? fmtDuration(a.avgDurationMs) : '—'}
              </Cell>
              <Cell num className="text-text-2">
                {a.totalCostUsd > 0 ? `$${a.totalCostUsd.toFixed(3)}` : '—'}
              </Cell>
            </Row>
          );
        })}
      </Table>
    </Card>
  );
}
