// Per-shape segment colors. Kept here (UI copy) rather than in packages/schemas.
const SHAPE_COLOR: Record<string, string> = {
  debugging: 'bg-orange-400',
  exploratory: 'bg-blue-400',
  'focused-edit': 'bg-green-400',
  minimal: 'bg-surface-2',
  'multi-tool': 'bg-purple-400',
  planning: 'bg-sky-400',
};

const SHAPE_DESC: Record<string, string> = {
  debugging: 'heavy execution, retries',
  exploratory: 'heavy reading, few edits',
  'focused-edit': 'concentrated edits',
  minimal: 'too few events to classify',
  'multi-tool': 'broad tool spread',
  planning: 'mostly conversation',
};

export function ShapeDistributionChart({ histogram }: { histogram: Record<string, number> }) {
  const entries = Object.entries(histogram).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-text-3">
        Session shapes
      </h2>

      {total === 0 ? (
        <p className="text-sm text-text-3">No classified sessions in this period.</p>
      ) : (
        <>
          <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full">
            {entries.map(([label, count]) => (
              <div
                key={label}
                className={SHAPE_COLOR[label] ?? 'bg-surface-2'}
                style={{ width: `${(count / total) * 100}%` }}
                title={`${label}: ${count}`}
              />
            ))}
          </div>
          <ul className="space-y-1.5 text-xs">
            {entries.map(([label, count]) => (
              <li key={label} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-text">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${SHAPE_COLOR[label] ?? 'bg-surface-2'}`}
                  />
                  {label}
                  <span className="text-text-3">— {SHAPE_DESC[label] ?? ''}</span>
                </span>
                <span className="text-text-2">{Math.round((count / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
