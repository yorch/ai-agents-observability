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
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-3">
        No tool activity recorded for this session
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {tools.length > 0 && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <h3 className="text-xs text-text-3 uppercase tracking-widest mb-3">Tools Used</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-3 text-xs border-b border-border">
                <th className="text-left pb-2">Tool</th>
                <th className="text-right pb-2 font-mono">Calls</th>
                <th className="text-right pb-2 font-mono">Errors</th>
                <th className="text-right pb-2 font-mono">Denied</th>
                <th className="text-right pb-2 font-mono">Avg ms</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((r) => (
                <tr key={r.toolName} className="border-b border-border-subtle">
                  <td className="py-2">
                    <span className="text-text-2 font-mono">{r.toolName}</span>
                    {r.toolCategory && (
                      <span className="ml-2 text-xs text-text-3">{r.toolCategory}</span>
                    )}
                  </td>
                  <td className="py-2 text-right text-text-2 font-mono">{r.callCount}</td>
                  <td
                    className={`py-2 text-right font-mono ${r.errorCount > 0 ? 'text-red-400' : 'text-text-3'}`}
                  >
                    {r.errorCount > 0 ? r.errorCount : '—'}
                  </td>
                  <td
                    className={`py-2 text-right font-mono ${r.deniedCount > 0 ? 'text-amber-400' : 'text-text-3'}`}
                  >
                    {r.deniedCount > 0 ? r.deniedCount : '—'}
                  </td>
                  <td className="py-2 text-right text-text-3 font-mono">
                    {r.avgDurationMs != null ? r.avgDurationMs : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subagents.length > 0 && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <h3 className="text-xs text-text-3 uppercase tracking-widest mb-3">Subagents Spawned</h3>
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
        </div>
      )}
    </div>
  );
}

export function SkillsTab({ rows }: { rows: SessionSkillRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-3">
        No skills used in this session
      </div>
    );
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
      <div className="rounded-lg border border-border bg-surface divide-y divide-border">
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
      </div>
    </div>
  );
}

export function ModelsTab({ costUsd, rows }: { costUsd: number; rows: ModelBreakdownRow[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h3 className="text-xs text-text-3 uppercase tracking-widest mb-4">Model Breakdown</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-text-3 text-xs border-b border-border">
            <th className="text-left pb-2">Model</th>
            <th className="text-right pb-2 font-mono">Calls</th>
            <th className="text-right pb-2 font-mono">Input</th>
            <th className="text-right pb-2 font-mono">Output</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="pt-4 text-center text-text-3">
                No model data
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.model} className="border-b border-border-subtle">
                <td className="py-2 text-text-2">{r.model}</td>
                <td className="py-2 text-right text-text-2 font-mono">{r.calls}</td>
                <td className="py-2 text-right text-text-2 font-mono">
                  {r.inputTokens > 0n ? r.inputTokens.toString() : '—'}
                </td>
                <td className="py-2 text-right text-text-2 font-mono">
                  {r.outputTokens > 0n ? r.outputTokens.toString() : '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="mt-4 pt-4 border-t border-border text-xs text-text-3">
        Total cost: <span className="text-text-2 font-mono">${costUsd.toFixed(4)}</span>
      </div>
    </div>
  );
}
