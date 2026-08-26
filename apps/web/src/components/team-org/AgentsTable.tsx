import { Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { fmtDuration, fmtUsdOrDash } from '@/lib/fmt';
import type { SubagentStatRow } from '@/lib/org-queries';

export function AgentsTable({
  agents,
  totalSpawns,
}: {
  agents: SubagentStatRow[];
  totalSpawns: number;
}) {
  if (agents.length === 0) {
    return (
      <Card>
        <CardEmpty>No activity in this period.</CardEmpty>
      </Card>
    );
  }
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
          // Two lenses on the same dollars (P14-004) — labelled apart so
          // neither reads as this agent's total, which their sum is not.
          { align: 'right', label: 'Turn share' },
          { align: 'right', label: 'Downstream' },
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
                {fmtUsdOrDash(a.attributedCostUsd)}
              </Cell>
              <Cell num className="text-text-2">
                {fmtUsdOrDash(a.downstreamCostUsd)}
              </Cell>
            </Row>
          );
        })}
      </Table>
    </Card>
  );
}
