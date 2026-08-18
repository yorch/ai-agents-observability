import { Card, CardEmpty, SectionHeader } from '@/components/ui';
import { fmtDayShort } from '@/lib/fmt';

/**
 * Daily invocation trend for a skill or command. The same block appeared
 * verbatim on four skill pages (org + team, index + detail).
 */
export function DailyTrendBars({
  points,
  title = 'Daily invocations',
}: {
  points: { count: number; day: Date }[];
  title?: string;
}) {
  if (points.length === 0) {
    return (
      <Card>
        <SectionHeader>{title}</SectionHeader>
        <CardEmpty>No activity in this period.</CardEmpty>
      </Card>
    );
  }
  const max = Math.max(...points.map((p) => p.count), 1);

  return (
    <Card>
      <SectionHeader>{title}</SectionHeader>
      <div className="flex h-16 items-end gap-1">
        {points.map((p) => (
          <div
            key={p.day.toISOString()}
            className="flex-1 rounded-t bg-accent"
            style={{ height: `${Math.max(2, (p.count / max) * 100)}%` }}
            title={`${fmtDayShort(p.day)}: ${p.count}`}
          />
        ))}
      </div>
    </Card>
  );
}
