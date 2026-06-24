import { FRICTION_VERSION } from '@/lib/effectiveness';

type Point = { date: string; frictionScore: number };

// Minimum scored sessions before we show a trend (DESIGN_DOC §10.6 — don't
// present a signal from too little data).
const MIN_SCORED = 3;

const W = 320;
const H = 80;

export function FrictionTrendChart({
  points,
  scoredSessionCount,
}: {
  points: Point[];
  scoredSessionCount: number;
}) {
  const header = (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-sm font-medium text-white/70">Friction over time</h2>
      <span className="text-[10px] uppercase tracking-wide text-white/30">
        Friction v{FRICTION_VERSION}
      </span>
    </div>
  );

  if (scoredSessionCount < MIN_SCORED || points.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        {header}
        <p className="text-sm text-white/40">
          Not enough data yet — friction needs at least {MIN_SCORED} scored sessions in this period.
        </p>
      </div>
    );
  }

  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - Math.min(Math.max(v, 0), 1) * H;
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.frictionScore).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${H.toFixed(1)} L${x(0).toFixed(1)},${H.toFixed(1)} Z`;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      {header}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-20 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Average friction score per day"
      >
        <path d={area} className="fill-brand-500/15" />
        <path d={line} className="fill-none stroke-brand-500" strokeWidth={1.5} />
      </svg>
      <div className="mt-2 flex justify-between text-[10px] text-white/30">
        <span>{points[0]?.date}</span>
        <span>0 (low) – 1 (high)</span>
        <span>{points[n - 1]?.date}</span>
      </div>
    </div>
  );
}
