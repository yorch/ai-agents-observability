import { agentDisplayName } from '@ai-agents-observability/schemas';
import { Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { fmtPct, fmtTokens, fmtUsdOrDash } from '@/lib/fmt';
import type { AgentComparisonRow } from '@/lib/org-queries';

// Side-by-side comparison of agent products (agent_type) on cost and quality.
// Single-agent orgs (only Claude Code) still render a one-row table — useful as a
// baseline before a second tool is adopted.
//
// P14-015: an agent whose adapter captures no token usage has UNKNOWN cost, not
// $0.00, and this is the table where the difference bites — it is the one place
// agents are read against each other, so a fabricated zero here reads as "that
// agent is free" rather than "we cannot see it". Such a row shows a dash and is
// named in the footnote, and `Prompts` gives it a unit of work that survives the
// gap. The distinction is decided in `getAgentTypeComparison`, from the data
// rather than from an agent name; this component only renders it.
export function AgentComparisonTable({ rows }: { rows: AgentComparisonRow[] }) {
  const unmeasured = rows.filter((r) => r.totalCostUsd === null).map((r) => r.agentType);

  return (
    <Card contentClassName="space-y-3">
      <div>
        <h2 className="font-display text-sm font-semibold text-text">Agent comparison</h2>
        <p className="text-xs text-text-3">
          Cost efficiency and outcome quality by coding agent · aggregate, visibility-scoped
        </p>
      </div>
      {rows.length === 0 ? (
        <CardEmpty>No agent activity in this period.</CardEmpty>
      ) : (
        <>
          <Table
            columns={[
              { label: 'Agent' },
              { align: 'right', label: 'Sessions' },
              { align: 'right', label: 'Prompts' },
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
                <Cell num className="text-text-2">
                  {r.prompts.toLocaleString()}
                </Cell>
                <Cell num>{fmtUsdOrDash(r.totalCostUsd)}</Cell>
                <Cell num>{fmtUsdOrDash(r.avgCostUsd)}</Cell>
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
          {unmeasured.length > 0 && (
            <p className="text-xs text-text-3">
              <span className="text-warn">Cost unknown, not zero</span> for{' '}
              {unmeasured.map((a) => agentDisplayName(a)).join(', ')}: no token usage reaches us
              from {unmeasured.length === 1 ? 'its adapter' : 'their adapters'}, so there is nothing
              to compute spend from. Compare on prompts and sessions instead — a dash is not a
              cheaper agent.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
