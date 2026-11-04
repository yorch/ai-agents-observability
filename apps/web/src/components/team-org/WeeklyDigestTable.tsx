import { Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { fmtUsd } from '@/lib/fmt';
import type { ScopedTrendPoint } from '@/lib/trend-queries';
import { completeWeeks } from '@/lib/weekly-digest';

/** Weekly digest uses complete Monday–Sunday UTC weeks, avoiding partial-week noise. */
export function WeeklyDigestTable({
  className,
  points,
}: {
  className?: string;
  points: ScopedTrendPoint[];
}) {
  const rows = completeWeeks(points);
  return (
    <Card className={className} title="Weekly digest" caption="Complete Monday–Sunday weeks · UTC">
      {rows.length === 0 ? (
        <CardEmpty>No complete week in this period.</CardEmpty>
      ) : (
        <Table
          columns={[
            { label: 'Week' },
            { align: 'right', label: 'Sessions' },
            { align: 'right', label: 'Spend' },
            { label: 'Peak day' },
          ]}
        >
          {rows.map((week) => (
            <Row key={week.start}>
              <Cell>
                {week.start} – {week.end}
              </Cell>
              <Cell num>{week.sessions.toLocaleString()}</Cell>
              <Cell num>{fmtUsd(week.costUsd)}</Cell>
              <Cell>{week.peak}</Cell>
            </Row>
          ))}
        </Table>
      )}
    </Card>
  );
}
