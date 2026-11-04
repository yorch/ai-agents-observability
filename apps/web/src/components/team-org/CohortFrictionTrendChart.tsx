import { AreaLine, Card, CardEmpty } from '@/components/ui';
import { FRICTION_VERSION } from '@/lib/effectiveness';
import type { FrictionTrendBucket } from '@/lib/effectiveness-queries';
import { fmtFriction } from '@/lib/fmt';

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
    <Card
      title={title}
      caption="Weekly median friction · 0 (low) to 1 (high)"
      hint={`v${FRICTION_VERSION}`}
    >
      {points.length === 0 ? (
        <CardEmpty>
          Not enough scored sessions per week to show a trend without risking re-identification.
        </CardEmpty>
      ) : (
        <AreaLine
          ariaLabel="Weekly median friction score"
          points={points.map((p) => p.median)}
          pointLabels={points.map((p) => p.weekStart)}
          startLabel={points[0]?.weekStart ?? ''}
          midLabel={`latest ${fmtFriction(points[points.length - 1]?.median ?? 0)}`}
          endLabel={points[points.length - 1]?.weekStart ?? ''}
        />
      )}
    </Card>
  );
}
