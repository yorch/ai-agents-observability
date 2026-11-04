import { Card, CardEmpty } from '@/components/ui';
import { FRICTION_VERSION } from '@/lib/effectiveness';
import type { EffectivenessDistribution } from '@/lib/effectiveness-queries';
import { fmtFriction } from '@/lib/fmt';

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
  const { friction, scoredSessions } = distribution;

  if (!friction || scoredSessions < MIN_AGG_SCORED) {
    return (
      <Card title={title} hint={`v${FRICTION_VERSION}`}>
        <CardEmpty>
          Not enough data — needs at least {MIN_AGG_SCORED} scored sessions in this period.
        </CardEmpty>
      </Card>
    );
  }

  const left = clamp(friction.p25) * 100;
  const right = clamp(friction.p75) * 100;
  const mid = clamp(friction.p50) * 100;

  return (
    <Card title={title} hint={`v${FRICTION_VERSION}`}>
      <div className="relative h-3 w-full rounded-full bg-surface-2">
        {/* p25–p75 interquartile span */}
        <div
          className="absolute h-full rounded-full bg-accent-muted"
          style={{ left: `${left}%`, width: `${Math.max(right - left, 0)}%` }}
        />
        {/* p50 marker */}
        <div
          className="absolute top-[-2px] h-[16px] w-0.5 bg-accent"
          style={{ left: `${mid}%` }}
          title={`median ${fmtFriction(friction.p50)}`}
        />
      </div>
      <div className="mt-3 flex justify-between text-xs text-text-2">
        <span>p25 {fmtFriction(friction.p25)}</span>
        <span className="text-text">median {fmtFriction(friction.p50)}</span>
        <span>p75 {fmtFriction(friction.p75)}</span>
      </div>
      <p className="mt-2 text-[10px] text-text-3">
        {scoredSessions} scored sessions · 0 (low) – 1 (high)
      </p>
    </Card>
  );
}
