const MODEL_COLORS = ['bg-accent', 'bg-accent/60', 'bg-accent/30'];

type ModelEntry = { costUsd: number; model: string; sessionCount: number; turns: number };

export function ModelMixChart({ models }: { models: ModelEntry[] }) {
  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-xs text-text-3 uppercase tracking-widest mb-4">Model Usage</h2>
        <p className="text-sm text-text-3">No data</p>
      </div>
    );
  }

  const totalTurns = Math.max(
    models.reduce((sum, m) => sum + m.turns, 0),
    1,
  );

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-xs text-text-3 uppercase tracking-widest mb-4">Model Usage</h2>

      {/* Segmented bar — proportional to turns */}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full mb-4 bg-surface-2">
        {models.map((m, i) => (
          <div
            key={m.model}
            className={MODEL_COLORS[i % MODEL_COLORS.length]}
            style={{ width: `${(m.turns / totalTurns) * 100}%` }}
            title={`${m.model}: ${m.turns} turns`}
          />
        ))}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-text-3 border-b border-border">
            <th className="text-left pb-2">Model</th>
            <th className="text-right pb-2 font-mono">Turns</th>
            <th className="text-right pb-2 font-mono">Sessions</th>
            <th className="text-right pb-2 font-mono">Cost</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model} className="border-b border-border-subtle">
              <td className="py-1.5 text-text-2 truncate max-w-[120px]">{m.model}</td>
              <td className="py-1.5 text-right text-text-2 font-mono">
                {m.turns.toLocaleString()}
              </td>
              <td className="py-1.5 text-right text-text-2 font-mono">{m.sessionCount}</td>
              <td className="py-1.5 text-right text-text-2 font-mono">${m.costUsd.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
