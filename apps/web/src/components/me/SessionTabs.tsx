import type { getSession, ModelBreakdownRow } from '@/lib/sessions-queries';

export function ToolsTab({
  session,
}: {
  session: Awaited<ReturnType<typeof getSession>> & object;
}) {
  const modelCounts = [
    { label: 'Tool calls', value: session.toolCallCount },
    { label: 'Tool errors', value: session.toolErrorCount },
  ];
  const max = Math.max(...modelCounts.map((m) => m.value), 1);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <h3 className="text-xs text-text-3 uppercase tracking-widest">Tool Activity</h3>
      {modelCounts.map((m) => (
        <div key={m.label}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-text-2">{m.label}</span>
            <span className="text-text-3 font-mono">{m.value}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${(m.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
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
