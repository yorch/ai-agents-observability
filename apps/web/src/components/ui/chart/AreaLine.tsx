const W = 320;
const H = 80;

/**
 * A single 0–1 series over time, drawn as a line with a soft area fill.
 *
 * Used for the friction trends, which share the same fixed domain and the same
 * three-part footer. `preserveAspectRatio="none"` is deliberate here: there is
 * no text inside the viewBox to distort, and letting the plot stretch to the
 * card's width is the point.
 */
export function AreaLine({
  ariaLabel,
  endLabel,
  midLabel,
  points,
  startLabel,
}: {
  ariaLabel: string;
  endLabel: string;
  /** Centred caption naming the measure and its domain. */
  midLabel: string;
  /** Values in [0, 1]; anything outside is clamped. */
  points: number[];
  startLabel: string;
}) {
  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - Math.min(Math.max(v, 0), 1) * H;
  const line = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${H.toFixed(1)} L${x(0).toFixed(1)},${H.toFixed(1)} Z`;

  return (
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-20 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
      >
        <path d={area} className="fill-accent-soft" />
        <path d={line} className="fill-none stroke-accent" strokeWidth={1.5} />
      </svg>
      <div className="mt-2 flex justify-between text-[10px] text-text-3">
        <span>{startLabel}</span>
        <span>{midLabel}</span>
        <span>{endLabel}</span>
      </div>
    </>
  );
}
