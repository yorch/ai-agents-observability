import { AreaLine, Card } from '@/components/ui';
import { FRICTION_VERSION } from '@/lib/effectiveness';
import type { FrictionTrendBucket } from '@/lib/effectiveness-queries';

// Weekly median-friction trend for a cohort (team or org). Buckets are already
// small-n suppressed by the query; if nothing survives we show an empty state.
export function CohortFrictionTrendChart({
  points,
  title,
}: {
  points: FrictionTrendBucket[];
  title: string;
}) {
  return (
    <Card title={title} hint={`v${FRICTION_VERSION}`}>
      {points.length === 0 ? (
        <p className="text-sm text-text-3">
          Not enough scored sessions per week to show a trend without risking re-identification.
        </p>
      ) : (
        <AreaLine
          ariaLabel="Weekly median friction score"
          points={points.map((p) => p.median)}
          startLabel={points[0]?.weekStart ?? ''}
          midLabel="weekly median · 0 (low) – 1 (high)"
          endLabel={points[points.length - 1]?.weekStart ?? ''}
        />
      )}
    </Card>
  );
}
