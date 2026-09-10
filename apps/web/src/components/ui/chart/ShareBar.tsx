export type ShareSegment = {
  /** Tailwind background class for this segment — a series or a domain colour. */
  className: string;
  key: string;
  /**
   * Accessible name for this segment, and its hover text.
   *
   * Named `label` rather than `title` on purpose. As `title` the field read as
   * "hover text", which invites a caller to put the segment's VALUE here and
   * nowhere else — data that exists only in a `title` attribute is unreachable
   * by keyboard, unreliable to a screen reader and absent on touch, which is
   * the defect this app has now fixed in several places. Every current caller
   * renders its own legend with the counts, so nothing was hover-only; the type
   * simply made the wrong thing easy.
   *
   * It is applied as an `aria-label` as well as a `title`, so a caller that
   * does put the value here still produces something reachable.
   */
  label: string;
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
            role="img"
            title={s.label}
            aria-label={s.label}
          />
        ))}
    </div>
  );
}
