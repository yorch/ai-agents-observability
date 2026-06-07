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
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-medium text-white/70">Tool &amp; Model Activity</h3>
      {modelCounts.map((m) => (
        <div key={m.label}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-white/70">{m.label}</span>
            <span className="text-white/50">{m.value}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-brand-500"
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
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-medium text-white/70 mb-4">Model Breakdown</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-white/40 text-xs border-b border-white/10">
            <th className="text-left pb-2">Model</th>
            <th className="text-right pb-2">Calls</th>
            <th className="text-right pb-2">Input tokens</th>
            <th className="text-right pb-2">Output tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="pt-4 text-center text-white/40">
                No model data
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.model} className="border-b border-white/5">
                <td className="py-2 text-white/70">{r.model}</td>
                <td className="py-2 text-right text-white/60">{r.calls}</td>
                <td className="py-2 text-right text-white/60">
                  {r.inputTokens > 0n ? r.inputTokens.toString() : '—'}
                </td>
                <td className="py-2 text-right text-white/60">
                  {r.outputTokens > 0n ? r.outputTokens.toString() : '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="mt-4 pt-4 border-t border-white/10 text-xs text-white/40">
        Total cost: <span className="text-white/70">${costUsd.toFixed(4)}</span>
      </div>
    </div>
  );
}
