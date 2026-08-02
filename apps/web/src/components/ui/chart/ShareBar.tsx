export type ShareSegment = {
  /** Tailwind background class for this segment — a series or a domain colour. */
  className: string;
  key: string;
  /** Hover text; the visible legend is the caller's, since each one differs. */
  title: string;
  value: number;
};

/**
 * A single bar divided by share — a model mix, an autonomy mix, a distribution
 * of session shapes. Four hand-rolled copies existed before this, differing in
 * height, whether they had a track behind them, and whether segments were
 * separated.
 *
 * The bar only. Legends stay with the caller because each carries different
 * secondary text (a percentage, a count, a one-line meaning), and forcing them
 * into one shape would lose that.
 */
export function ShareBar({ segments, total }: { segments: ShareSegment[]; total: number }) {
  const denominator = total > 0 ? total : 1;
  return (
    <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2">
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <span
            key={s.key}
            className={s.className}
            style={{ width: `${(s.value / denominator) * 100}%` }}
            title={s.title}
          />
        ))}
    </div>
  );
}
