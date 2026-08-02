import { AreaLine, Card } from '@/components/ui';
import { FRICTION_VERSION } from '@/lib/effectiveness';

type Point = { date: string; frictionScore: number };

// Minimum scored sessions before we show a trend (DESIGN_DOC §10.6 — don't
// present a signal from too little data).
const MIN_SCORED = 3;

export function FrictionTrendChart({
  points,
  scoredSessionCount,
}: {
  points: Point[];
  scoredSessionCount: number;
}) {
  const enough = scoredSessionCount >= MIN_SCORED && points.length > 0;

  return (
    <Card title="Friction over time" hint={`v${FRICTION_VERSION}`}>
      {enough ? (
        <AreaLine
          ariaLabel="Average friction score per day"
          points={points.map((p) => p.frictionScore)}
          startLabel={points[0]?.date ?? ''}
          midLabel="0 (low) – 1 (high)"
          endLabel={points[points.length - 1]?.date ?? ''}
        />
      ) : (
        <p className="text-sm text-text-3">
          Not enough data yet — friction needs at least {MIN_SCORED} scored sessions in this period.
        </p>
      )}
    </Card>
  );
}
