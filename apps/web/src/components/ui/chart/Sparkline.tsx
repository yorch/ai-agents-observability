const W = 66;
const H = 22;

type Tone = 'good' | 'warn' | 'crit' | 'neutral' | 'accent';

const STROKE: Record<Tone, string> = {
  accent: 'stroke-accent',
  crit: 'stroke-crit',
  good: 'stroke-good',
  neutral: 'stroke-text-3',
  warn: 'stroke-warn',
};
const DOT: Record<Tone, string> = {
  accent: 'fill-accent',
  crit: 'fill-crit',
  good: 'fill-good',
  neutral: 'fill-text-3',
  warn: 'fill-warn',
};

/**
 * Trend shape for a stat tile — no axes, no labels. The endpoint gets a dot so
 * the eye lands on "where it is now" rather than the whole line.
 */
export function Sparkline({ points, tone = 'neutral' }: { points: number[]; tone?: Tone }) {
  if (points.length < 2) {
    return null;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  // Inset by the dot radius so the endpoint marker never clips the viewBox.
  const x = (i: number) => 2 + (i / (points.length - 1)) * (W - 4);
  const y = (v: number) => H - 3 - ((v - min) / span) * (H - 6);

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p).toFixed(1)}`);
  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1] ?? 0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-5 w-16 shrink-0" role="presentation" aria-hidden>
      <path
        d={d.join(' ')}
        fill="none"
        className={STROKE[tone]}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r={2.2} className={DOT[tone]} />
    </svg>
  );
}
