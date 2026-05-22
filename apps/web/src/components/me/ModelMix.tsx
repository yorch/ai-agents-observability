import type { ModelMix } from '../../lib/me-queries';

export function ModelMixChart({ models }: { models: ModelMix[] }) {
  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h2 className="text-sm font-medium text-white/70 mb-4">Model Usage</h2>
        <p className="text-sm text-white/40">No data</p>
      </div>
    );
  }

  const totalTurns = models.reduce((sum, m) => sum + m.turns, 0) || 1;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h2 className="text-sm font-medium text-white/70 mb-4">Model Usage</h2>

      {/* Segmented bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full mb-4">
        {models.map((m, i) => {
          const colors = ['bg-brand-500', 'bg-brand-600', 'bg-brand-700'];
          const color = colors[i % colors.length];
          return (
            <div
              key={m.model}
              className={color}
              style={{ width: `${(m.turns / totalTurns) * 100}%` }}
              title={`${m.model}: ${m.turns} turns`}
            />
          );
        })}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-white/40 border-b border-white/10">
            <th className="text-left pb-2">Model</th>
            <th className="text-right pb-2">Turns</th>
            <th className="text-right pb-2">Cost</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model} className="border-b border-white/5">
              <td className="py-1.5 text-white/80 truncate max-w-[120px]">{m.model}</td>
              <td className="py-1.5 text-right text-white/60">{m.turns}</td>
              <td className="py-1.5 text-right text-white/60">${m.costUsd.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
