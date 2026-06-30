import type { FrictionSources } from '@/lib/effectiveness-queries';

// Order, label, color, and one-line meaning for each friction driver. The keys
// match FrictionSources; the values are the mean weighted contribution to friction.
const DRIVERS: { color: string; desc: string; key: keyof FrictionSources; label: string }[] = [
  { color: 'bg-yellow-400', desc: 'permission prompts denied', key: 'denial', label: 'Denials' },
  { color: 'bg-red-400', desc: 'tool calls that errored', key: 'error', label: 'Tool errors' },
  {
    color: 'bg-sky-400',
    desc: 'sessions interrupted mid-task',
    key: 'interrupt',
    label: 'Interrupts',
  },
  {
    color: 'bg-purple-400',
    desc: 'sessions abandoned within a minute',
    key: 'abandonment',
    label: 'Early abandonment',
  },
];

export function FrictionSourcesChart({
  scoredSessionCount,
  sources,
}: {
  scoredSessionCount: number;
  sources: FrictionSources;
}) {
  const total = DRIVERS.reduce((sum, d) => sum + sources[d.key], 0);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-text-3">
        Friction sources
      </h2>
      <p className="mb-4 text-xs text-text-3">
        What drives your average friction, across {scoredSessionCount} scored session
        {scoredSessionCount === 1 ? '' : 's'}.
      </p>

      {scoredSessionCount === 0 ? (
        <p className="text-sm text-text-3">No scored sessions in this period.</p>
      ) : total === 0 ? (
        <p className="text-sm text-text-2">No measurable friction — your sessions ran clean. 🎉</p>
      ) : (
        <>
          <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full bg-surface-2">
            {DRIVERS.map((d) =>
              sources[d.key] > 0 ? (
                <div
                  key={d.key}
                  className={d.color}
                  style={{ width: `${(sources[d.key] / total) * 100}%` }}
                  title={`${d.label}: ${Math.round((sources[d.key] / total) * 100)}%`}
                />
              ) : null,
            )}
          </div>
          <ul className="space-y-1.5 text-xs">
            {DRIVERS.map((d) => (
              <li key={d.key} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-text">
                  <span className={`inline-block h-2 w-2 rounded-full ${d.color}`} />
                  {d.label}
                  <span className="text-text-3">— {d.desc}</span>
                </span>
                <span className="text-text-2">{Math.round((sources[d.key] / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
