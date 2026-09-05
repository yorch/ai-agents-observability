import { Card, CardEmpty, Cell, ChartHover, Row, SectionHeader, Table } from '@/components/ui';
import { fmtDayShort } from '@/lib/fmt';

/**
 * Daily invocation trend for a skill or command. The same block appeared
 * verbatim on four skill pages (org + team, index + detail).
 *
 * Each bar was previously a bare `<div>` whose only data was a `title`
 * attribute: unreachable by keyboard, unreliable to a screen reader, and absent
 * on touch, which made the whole chart an empty row of colour to anyone not
 * using a mouse. It now follows the house chart grammar — `data-tip` marks
 * inside `ChartHover`, each focusable with an `aria-label` repeating the tooltip
 * value — plus the `<details>` table the other charts carry, which is what makes
 * the series readable rather than merely reachable.
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
      <ChartHover>
        <div className="flex h-16 items-end gap-1">
          {points.map((p) => (
            <div
              key={p.day.toISOString()}
              role="img"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: chart marks need keyboard tooltip parity
              tabIndex={0}
              aria-label={`${fmtDayShort(p.day)}: ${p.count.toLocaleString()}`}
              data-tip={`${fmtDayShort(p.day)}|${p.count.toLocaleString()}`}
              className="flex-1 rounded-t bg-accent outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
              style={{ height: `${Math.max(2, (p.count / max) * 100)}%` }}
            />
          ))}
        </div>
      </ChartHover>
      <details className="mt-4 text-sm text-text-2">
        <summary className="cursor-pointer text-text-3">View chart data</summary>
        <Table columns={[{ label: 'Day' }, { align: 'right', label: 'Invocations' }]}>
          {points.map((p) => (
            <Row key={p.day.toISOString()}>
              <Cell>{fmtDayShort(p.day)}</Cell>
              <Cell num>{p.count.toLocaleString()}</Cell>
            </Row>
          ))}
        </Table>
      </details>
    </Card>
  );
}
