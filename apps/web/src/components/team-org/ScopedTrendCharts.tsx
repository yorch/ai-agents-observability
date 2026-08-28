import { BarChart, Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { fmtDayShort, fmtUsd } from '@/lib/fmt';
import type { ScopedTrendPoint } from '@/lib/trend-queries';

const MIN_POINTS = 2;

function modelSeries(points: ScopedTrendPoint[]) {
  const totals = new Map<string, number>();
  for (const point of points) {
    for (const model of point.models) {
      totals.set(model.model, (totals.get(model.model) ?? 0) + model.costUsd);
    }
  }
  const models = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  return models.length <= 6 ? models : [...models.slice(0, 5), 'Other'];
}

export function ScopedTrendCharts({ points }: { points: ScopedTrendPoint[] }) {
  const models = modelSeries(points);
  const namedModels = new Set(models.filter((model) => model !== 'Other'));
  const enough = points.length >= MIN_POINTS;
  const chartData = points.map((point) => ({
    label: fmtDayShort(point.day),
    values: models.map((model) =>
      model === 'Other'
        ? point.models
            .filter((item) => !namedModels.has(item.model))
            .reduce((sum, item) => sum + item.costUsd, 0)
        : (point.models.find((item) => item.model === model)?.costUsd ?? 0),
    ),
  }));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Daily spend" caption="Cost by session start day">
        {!enough ? (
          <CardEmpty>
            No spend trend in this period. At least two active days are needed to show a trend.
          </CardEmpty>
        ) : (
          <BarChart data={chartData} series={models} format={fmtUsd} />
        )}
      </Card>
      <Card title="Session burn" caption="Sessions by day">
        {!enough ? (
          <CardEmpty>
            No session trend in this period. At least two active days are needed to show a trend.
          </CardEmpty>
        ) : (
          <BarChart
            data={points.map((point) => ({
              label: fmtDayShort(point.day),
              values: [point.sessionCount],
            }))}
            series={['Sessions']}
            format={(value) => value.toLocaleString()}
          />
        )}
      </Card>
      <Card
        title="Trend data"
        caption="Exact daily values for accessible comparison"
        className="lg:col-span-2"
        flush
      >
        {points.length === 0 ? (
          <CardEmpty>No activity in this period.</CardEmpty>
        ) : (
          <Table
            columns={[
              { label: 'Day' },
              { align: 'right', label: 'Sessions' },
              { align: 'right', label: 'Spend' },
            ]}
          >
            {points.map((point) => (
              <Row key={point.day.toISOString()}>
                <Cell>{fmtDayShort(point.day)}</Cell>
                <Cell num>{point.sessionCount.toLocaleString()}</Cell>
                <Cell num>{fmtUsd(point.costUsd)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
