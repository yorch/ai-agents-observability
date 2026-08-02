import { agentDisplayName } from '@ai-agents-observability/schemas';
import { Card, Cell, Row, Table } from '@/components/ui';
import { fmtPct, fmtUsd } from '@/lib/fmt';
import type { AgentComparisonRow } from '@/lib/org-queries';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}k`;
  }
  return String(n);
}

// Side-by-side comparison of agent products (agent_type) on cost and quality.
// Single-agent orgs (only Claude Code) still render a one-row table — useful as a
// baseline before a second tool is adopted.
export function AgentComparisonTable({ rows }: { rows: AgentComparisonRow[] }) {
  return (
    <Card contentClassName="space-y-3">
      <div>
        <h2 className="font-display text-sm font-semibold text-text">Agent comparison</h2>
        <p className="text-xs text-text-3">
          Cost efficiency and outcome quality by coding agent · aggregate, visibility-scoped
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-text-3">No agent activity in this window.</p>
      ) : (
        <Table
          columns={[
            { label: 'Agent' },
            { align: 'right', label: 'Sessions' },
            { align: 'right', label: 'Total cost' },
            { align: 'right', label: 'Avg cost / session' },
            { align: 'right', label: 'Median friction' },
            { align: 'right', label: 'Tool error rate' },
            { align: 'right', label: 'Tokens' },
          ]}
        >
          {rows.map((r) => (
            <Row key={r.agentType}>
              <Cell className="text-text">{agentDisplayName(r.agentType)}</Cell>
              <Cell num className="text-text-2">
                {r.sessions.toLocaleString()}
              </Cell>
              <Cell num>{fmtUsd(r.totalCostUsd)}</Cell>
              <Cell num>{fmtUsd(r.avgCostUsd)}</Cell>
              <Cell num className="text-text-2">
                {r.medianFriction != null ? r.medianFriction.toFixed(2) : '—'}
              </Cell>
              <Cell
                num
                className={`py-2 text-right font-mono ${r.toolErrorRate != null && r.toolErrorRate > 0.1 ? 'text-warn' : 'text-text-2'}`}
              >
                {r.toolErrorRate != null ? fmtPct(r.toolErrorRate) : '—'}
              </Cell>
              <Cell num className="text-text-2">
                {fmtTokens(r.totalTokens)}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </Card>
  );
}
