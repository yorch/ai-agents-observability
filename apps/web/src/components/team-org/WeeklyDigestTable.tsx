import { Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { fmtUsd } from '@/lib/fmt';
import type { ScopedTrendPoint } from '@/lib/trend-queries';
import { completeWeeks } from '@/lib/weekly-digest';

/** Weekly digest uses complete Monday–Sunday UTC weeks, avoiding partial-week noise. */
export async function WeeklyDigestTable({ points }: { points: ScopedTrendPoint[] }) {
  const { dict } = await getTranslations();
  const rows = completeWeeks(points);
  return (
    <Card title={dict.org.weeklyDigest.title} caption={dict.org.weeklyDigest.caption}>
      {rows.length === 0 ? (
        <CardEmpty>{dict.org.weeklyDigest.empty}</CardEmpty>
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
