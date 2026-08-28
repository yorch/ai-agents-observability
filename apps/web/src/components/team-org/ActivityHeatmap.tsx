import { Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { fmtUsd } from '@/lib/fmt';
import type { ActivityHeatmapCell } from '@/lib/trend-queries';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function labelHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** A UTC weekday/hour activity map with an exact-data fallback for accessibility. */
export function ActivityHeatmap({ cells }: { cells: ActivityHeatmapCell[] }) {
  const bySlot = new Map(cells.map((cell) => [`${cell.dayOfWeek}:${cell.hour}`, cell]));
  const max = Math.max(...cells.map((cell) => cell.sessionCount), 1);
  return (
    <Card
      title="Activity by hour"
      caption="UTC weekday and start hour · darker cells indicate more sessions"
    >
      {cells.length === 0 ? (
        <CardEmpty>No hourly activity in this period.</CardEmpty>
      ) : (
        <>
          <div className="overflow-x-auto">
            <div
              className="grid min-w-[720px] gap-1 text-[10px] text-text-3"
              style={{ gridTemplateColumns: '2.5rem repeat(24, minmax(1.25rem, 1fr))' }}
              role="img"
              aria-label="Session count by weekday and UTC hour"
            >
              <span aria-hidden="true" />
              {HOURS.map((hour) => (
                <span className="text-center" key={hour}>
                  {hour}
                </span>
              ))}
              {DAYS.map((day, dayOfWeek) => (
                <div className="contents" key={day}>
                  <span className="self-center">{day}</span>
                  {HOURS.map((hour) => {
                    const cell = bySlot.get(`${dayOfWeek}:${hour}`);
                    const sessions = cell?.sessionCount ?? 0;
                    return (
                      <span
                        className="aspect-square rounded-sm bg-accent-muted"
                        key={hour}
                        title={`${day} ${labelHour(hour)} UTC: ${sessions.toLocaleString()} sessions`}
                        style={{ opacity: sessions ? 0.2 + 0.8 * Math.sqrt(sessions / max) : 0.08 }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <details className="mt-4 text-sm text-text-2">
            <summary className="cursor-pointer text-text-3">View hourly data</summary>
            <Table
              columns={[
                { label: 'Day / hour' },
                { align: 'right', label: 'Sessions' },
                { align: 'right', label: 'Spend' },
              ]}
            >
              {cells.map((cell) => (
                <Row key={`${cell.dayOfWeek}:${cell.hour}`}>
                  <Cell>
                    {DAYS[cell.dayOfWeek]} {labelHour(cell.hour)} UTC
                  </Cell>
                  <Cell num>{cell.sessionCount.toLocaleString()}</Cell>
                  <Cell num>{fmtUsd(cell.costUsd)}</Cell>
                </Row>
              ))}
            </Table>
          </details>
        </>
      )}
    </Card>
  );
}
