import { FRICTION_VERSION } from '@/lib/effectiveness';
import type { EffectivenessDistribution } from '@/lib/effectiveness-queries';

// Suppress aggregate friction below this many scored sessions, to prevent
// re-identifying individuals in small teams (P7-004). Not configurable.
const MIN_AGG_SCORED = 5;

const clamp = (v: number) => Math.min(Math.max(v, 0), 1);

export function FrictionDistributionChart({
  distribution,
  title = 'Friction distribution',
}: {
  distribution: EffectivenessDistribution;
  title?: string;
}) {
  const header = (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">{title}</h2>
      <span className="text-[10px] uppercase tracking-wide text-text-3">v{FRICTION_VERSION}</span>
    </div>
  );

  const { friction, scoredSessions } = distribution;

  if (!friction || scoredSessions < MIN_AGG_SCORED) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        {header}
        <p className="text-sm text-text-3">
          Not enough data — needs at least {MIN_AGG_SCORED} scored sessions in this period.
        </p>
      </div>
    );
  }

  const left = clamp(friction.p25) * 100;
  const right = clamp(friction.p75) * 100;
  const mid = clamp(friction.p50) * 100;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      {header}
      <div className="relative h-3 w-full rounded-full bg-surface-2">
        {/* p25–p75 interquartile span */}
        <div
          className="absolute h-full rounded-full bg-accent/40"
          style={{ left: `${left}%`, width: `${Math.max(right - left, 0)}%` }}
        />
        {/* p50 marker */}
        <div
          className="absolute top-[-2px] h-[16px] w-0.5 bg-accent"
          style={{ left: `${mid}%` }}
          title={`median ${friction.p50.toFixed(2)}`}
        />
      </div>
      <div className="mt-3 flex justify-between text-xs text-text-2">
        <span>p25 {friction.p25.toFixed(2)}</span>
        <span className="text-text">median {friction.p50.toFixed(2)}</span>
        <span>p75 {friction.p75.toFixed(2)}</span>
      </div>
      <p className="mt-2 text-[10px] text-text-3">
        {scoredSessions} scored sessions · 0 (low) – 1 (high)
      </p>
    </div>
  );
}
