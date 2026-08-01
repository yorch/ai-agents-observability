import { seriesBg } from './scale';

export type HBarDatum = {
  /** Fixed series index, so a colour follows the entity rather than its rank. */
  index?: number;
  label: string;
  value: number;
  /** Rendered at the row end — pre-formatted so the caller owns the units. */
  display: string;
};

/**
 * Horizontal magnitude bars — the right form for "cost by team", "top tools",
 * anything where the question is which is biggest and by how much. Rows keep
 * source order; sort before passing if rank is the point.
 */
export function HBars({ rows, tinted = true }: { rows: HBarDatum[]; tinted?: boolean }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-text-3">Nothing recorded yet.</p>;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="space-y-2.5">
      {rows.map((row, i) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3">
          <span className="truncate text-xs text-text-2" title={row.label}>
            {row.label}
          </span>
          <span className="block h-2 overflow-hidden rounded-full bg-surface-2">
            <span
              className={`block h-full rounded-r-full ${tinted ? seriesBg(row.index ?? i) : 'bg-accent'}`}
              style={{ width: `${Math.max(1.5, (row.value / max) * 100)}%` }}
            />
          </span>
          <span className="text-right font-mono text-xs text-text">{row.display}</span>
        </li>
      ))}
    </ul>
  );
}
