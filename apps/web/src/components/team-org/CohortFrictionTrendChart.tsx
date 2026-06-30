import { FRICTION_VERSION } from '@/lib/effectiveness';
import type { FrictionTrendBucket } from '@/lib/effectiveness-queries';

const W = 320;
const H = 80;

// Weekly median-friction trend for a cohort (team or org). Buckets are already
// small-n suppressed by the query; if nothing survives we show an empty state.
export function CohortFrictionTrendChart({
  points,
  title,
}: {
  points: FrictionTrendBucket[];
  title: string;
}) {
  const header = (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">{title}</h2>
      <span className="text-[10px] uppercase tracking-wide text-text-3">v{FRICTION_VERSION}</span>
    </div>
  );

  if (points.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        {header}
        <p className="text-sm text-text-3">
          Not enough scored sessions per week to show a trend without risking re-identification.
        </p>
      </div>
    );
  }

  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - Math.min(Math.max(v, 0), 1) * H;
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.median).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${H.toFixed(1)} L${x(0).toFixed(1)},${H.toFixed(1)} Z`;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      {header}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-20 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Weekly median friction score"
      >
        <path d={area} className="fill-brand-500/15" />
        <path d={line} className="fill-none stroke-brand-500" strokeWidth={1.5} />
      </svg>
      <div className="mt-2 flex justify-between text-[10px] text-text-3">
        <span>{points[0]?.weekStart}</span>
        <span>weekly median · 0 (low) – 1 (high)</span>
        <span>{points[n - 1]?.weekStart}</span>
      </div>
    </div>
  );
}
