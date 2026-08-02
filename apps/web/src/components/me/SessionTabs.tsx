import { Card, Cell, EmptyState, Row, Table } from '@/components/ui';
import type {
  ModelBreakdownRow,
  SessionSkillRow,
  SessionSubagentRow,
  SessionToolRow,
} from '@/lib/sessions-queries';

export function ToolsTab({
  subagents,
  tools,
}: {
  subagents: SessionSubagentRow[];
  tools: SessionToolRow[];
}) {
  if (tools.length === 0 && subagents.length === 0) {
    return <EmptyState>No tool activity recorded for this session</EmptyState>;
  }

  return (
    <div className="space-y-4">
      {tools.length > 0 && (
        <Card>
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-text-3">
            Tools Used
          </h3>
          <Table
            columns={[
              { label: 'Tool' },
              { align: 'right', label: 'Calls', mono: true },
              { align: 'right', label: 'Errors', mono: true },
              { align: 'right', label: 'Denied', mono: true },
              { align: 'right', label: 'Avg ms', mono: true },
            ]}
          >
            {tools.map((r) => (
              <Row key={r.toolName}>
                <Cell>
                  <span className="text-text-2 font-mono">{r.toolName}</span>
                  {r.toolCategory && (
                    <span className="ml-2 text-xs text-text-3">{r.toolCategory}</span>
                  )}
                </Cell>
                <Cell num className="text-text-2">
                  {r.callCount}
                </Cell>
                <Cell
                  num
                  className={`py-2 text-right font-mono ${r.errorCount > 0 ? 'text-crit' : 'text-text-3'}`}
                >
                  {r.errorCount > 0 ? r.errorCount : '—'}
                </Cell>
                <Cell
                  num
                  className={`py-2 text-right font-mono ${r.deniedCount > 0 ? 'text-warn' : 'text-text-3'}`}
                >
                  {r.deniedCount > 0 ? r.deniedCount : '—'}
                </Cell>
                <Cell num className="text-text-3">
                  {r.avgDurationMs != null ? r.avgDurationMs : '—'}
                </Cell>
              </Row>
            ))}
          </Table>
        </Card>
      )}

      {subagents.length > 0 && (
        <Card>
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-text-3">
            Subagents Spawned
          </h3>
          <div className="divide-y divide-border">
            {subagents.map((r) => (
              <div key={r.subagentType} className="flex items-center justify-between py-2">
                <span className="text-sm text-text-2 font-mono">{r.subagentType}</span>
                <span className="text-xs font-mono text-text-3 bg-surface-2 px-2 py-0.5 rounded">
                  ×{r.useCount}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export function SkillsTab({ rows }: { rows: SessionSkillRow[] }) {
  if (rows.length === 0) {
    return <EmptyState>No skills used in this session</EmptyState>;
  }

  const total = rows.reduce((sum, r) => sum + r.useCount, 0);

  return (
    <div className="space-y-3">
      <div className="flex gap-4">
        <div className="rounded-lg border border-border bg-surface px-4 py-3">
          <p className="text-xs text-text-3 uppercase tracking-widest">Distinct skills</p>
          <p className="text-2xl font-display font-semibold text-text mt-1">{rows.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface px-4 py-3">
          <p className="text-xs text-text-3 uppercase tracking-widest">Total invocations</p>
          <p className="text-2xl font-display font-semibold text-text mt-1">{total}</p>
        </div>
      </div>
      <Card flush contentClassName="divide-y divide-border">
        {rows.map((r) => (
          <div key={r.skillName} className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <span className="text-sm text-text font-mono">/{r.skillName}</span>
              {r.skillPath && (
                <span className="ml-2 text-xs text-text-3 truncate">{r.skillPath}</span>
              )}
            </div>
            <span className="ml-4 shrink-0 rounded bg-surface-2 px-2 py-0.5 text-xs font-mono text-text-3">
              ×{r.useCount}
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

export function ModelsTab({ costUsd, rows }: { costUsd: number; rows: ModelBreakdownRow[] }) {
  return (
    <Card>
      <h3 className="text-xs text-text-3 uppercase tracking-widest mb-4">Model Breakdown</h3>
      <Table
        columns={[
          { label: 'Model' },
          { align: 'right', label: 'Calls', mono: true },
          { align: 'right', label: 'Input', mono: true },
          { align: 'right', label: 'Output', mono: true },
        ]}
      >
        {rows.length === 0 ? (
          <Row>
            <Cell colSpan={4} className="pt-4 text-center text-text-3">
              No model data
            </Cell>
          </Row>
        ) : (
          rows.map((r) => (
            <Row key={r.model}>
              <Cell className="text-text-2">{r.model}</Cell>
              <Cell num className="text-text-2">
                {r.calls}
              </Cell>
              <Cell num className="text-text-2">
                {r.inputTokens > 0n ? r.inputTokens.toString() : '—'}
              </Cell>
              <Cell num className="text-text-2">
                {r.outputTokens > 0n ? r.outputTokens.toString() : '—'}
              </Cell>
            </Row>
          ))
        )}
      </Table>
      <div className="mt-4 pt-4 border-t border-border text-xs text-text-3">
        Total cost: <span className="text-text-2 font-mono">${costUsd.toFixed(4)}</span>
      </div>
    </Card>
  );
}
