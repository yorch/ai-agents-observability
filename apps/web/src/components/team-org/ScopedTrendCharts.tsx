import { BarChart, ButtonLink, Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { fmtDayShort, fmtUsd } from '@/lib/fmt';
import type { CostDurationPoint } from '@/lib/scatter-queries';
import type { ActivityHeatmapCell, ConcurrencyPoint, ScopedTrendPoint } from '@/lib/trend-queries';
import { ActivityHeatmap } from './ActivityHeatmap';
import { CostDurationScatter } from './CostDurationScatter';
import { WeeklyDigestTable } from './WeeklyDigestTable';

const MIN_POINTS = 2;

/** A compact, aggregate-only 90-day view of when sessions were active. */
async function ActivityCalendar({ points }: { points: ScopedTrendPoint[] }) {
  const { dict } = await getTranslations();
  const byDay = new Map(points.map((point) => [point.day.toISOString().slice(0, 10), point]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 90);
  const max = Math.max(...points.map((point) => point.sessionCount), 1);
  const days = Array.from({ length: 91 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    return day;
  });

  return (
    <Card
      title={dict.org.trends.activityCalendar}
      caption={dict.org.trends.activityCalendarCaption}
    >
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }}
        role="img"
        aria-label={dict.org.trends.activityCalendarAria}
      >
        {days.map((day) => {
          const key = day.toISOString().slice(0, 10);
          const sessions = byDay.get(key)?.sessionCount ?? 0;
          return (
            <span
              key={key}
              role="img"
              aria-label={`${key}: ${sessions.toLocaleString()} sessions`}
              className="aspect-square rounded-sm bg-accent-muted"
              style={{ opacity: sessions ? 0.2 + 0.8 * Math.sqrt(sessions / max) : 0.08 }}
              title={`${key}: ${sessions.toLocaleString()} sessions`}
            />
          );
        })}
      </div>
      <details className="mt-4 text-sm text-text-2">
        <summary className="cursor-pointer text-text-3">{dict.org.trends.viewCalendarData}</summary>
        <Table
          columns={[
            { label: 'Day' },
            { align: 'right', label: 'Sessions' },
            { align: 'right', label: 'Spend' },
          ]}
        >
          {days
            .filter((day) => byDay.has(day.toISOString().slice(0, 10)))
            .map((day) => {
              const point = byDay.get(day.toISOString().slice(0, 10));
              if (!point) {
                return null;
              }
              return (
                <Row key={day.toISOString()}>
                  <Cell>{day.toISOString().slice(0, 10)}</Cell>
                  <Cell num>{point.sessionCount.toLocaleString()}</Cell>
                  <Cell num>{fmtUsd(point.costUsd)}</Cell>
                </Row>
              );
            })}
        </Table>
      </details>
    </Card>
  );
}

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

export async function ScopedTrendCharts({
  points,
  scatter,
  aggregateScatter = false,
  concurrency = [],
  heatmap = [],
  drilldownHref,
}: {
  points: ScopedTrendPoint[];
  scatter?: CostDurationPoint[];
  aggregateScatter?: boolean;
  concurrency?: ConcurrencyPoint[];
  heatmap?: ActivityHeatmapCell[];
  drilldownHref?: string | undefined;
}) {
  const { dict } = await getTranslations();
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
      {scatter && (
        <div className="lg:col-span-2">
          <CostDurationScatter
            aggregate={aggregateScatter}
            points={scatter}
            drilldownHref={drilldownHref}
          />
        </div>
      )}
      <Card title={dict.org.trends.dailySpend} caption={dict.org.trends.dailySpendCaption}>
        {!enough ? (
          <CardEmpty>{dict.org.trends.dailySpendEmpty}</CardEmpty>
        ) : (
          <BarChart data={chartData} series={models} format={fmtUsd} />
        )}
      </Card>
      <Card title={dict.org.trends.sessionBurn} caption={dict.org.trends.sessionBurnCaption}>
        {!enough ? (
          <CardEmpty>{dict.org.trends.noSessionTrend}</CardEmpty>
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
        title={dict.org.trends.trendData}
        caption={dict.org.trends.trendDataCaption}
        className="lg:col-span-2"
        flush
      >
        {points.length === 0 ? (
          <CardEmpty>{dict.org.trends.empty}</CardEmpty>
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
      <ActivityCalendar points={points} />
      <ActivityHeatmap cells={heatmap} />
      <WeeklyDigestTable points={points} />
      {drilldownHref && (
        <ButtonLink href={drilldownHref} size="sm" variant="secondary">
          {dict.org.trends.exploreSessions}
        </ButtonLink>
      )}
      {concurrency.length > 0 && <ConcurrencyCharts points={concurrency} />}
    </div>
  );
}

async function ConcurrencyCharts({ points }: { points: ConcurrencyPoint[] }) {
  const { dict } = await getTranslations();
  const active = points.filter((point) => point.sessionCount > 0);
  const peak = Math.max(...active.map((point) => point.peakConcurrent), 0);
  return (
    <div className="grid gap-6 lg:col-span-2 lg:grid-cols-2">
      <Card
        title={dict.org.trends.parallelSessions}
        caption={dict.org.trends.parallelSessionsCaption}
      >
        {active.length === 0 ? (
          <CardEmpty>{dict.org.trends.noParallelActivity}</CardEmpty>
        ) : (
          <BarChart
            data={active.map((point) => ({
              label: fmtDayShort(point.day),
              values: [point.peakConcurrent],
            }))}
            series={['Peak concurrent sessions']}
            format={(value) => value.toLocaleString()}
          />
        )}
        <p className="mt-3 text-xs text-text-3">
          {peak > 1
            ? format(dict.org.trends.peakOverlap, { peak: peak.toLocaleString() })
            : dict.org.trends.noOverlap}
        </p>
      </Card>
      <Card title={dict.org.trends.parallelShare} caption={dict.org.trends.parallelShareCaption}>
        {active.length === 0 ? (
          <CardEmpty>{dict.org.trends.noSessionOverlap}</CardEmpty>
        ) : (
          <BarChart
            data={active.map((point) => ({
              label: fmtDayShort(point.day),
              values: [point.parallelShare * 100],
            }))}
            series={['Sessions with overlap']}
            format={(value) => `${value.toFixed(0)}%`}
          />
        )}
      </Card>
      <Card
        title={dict.org.trends.concurrencyData}
        caption={dict.org.trends.concurrencyDataCaption}
        className="lg:col-span-2"
        flush
      >
        {active.length === 0 ? (
          <CardEmpty>{dict.org.trends.noParallelActivity}</CardEmpty>
        ) : (
          <Table
            columns={[
              { label: 'Day' },
              { align: 'right', label: 'Sessions' },
              { align: 'right', label: 'Peak concurrent' },
              { align: 'right', label: 'Parallel sessions' },
              { align: 'right', label: 'Share' },
            ]}
          >
            {active.map((point) => (
              <Row key={point.day.toISOString()}>
                <Cell>{fmtDayShort(point.day)}</Cell>
                <Cell num>{point.sessionCount.toLocaleString()}</Cell>
                <Cell num>{point.peakConcurrent.toLocaleString()}</Cell>
                <Cell num>{point.parallelSessionCount.toLocaleString()}</Cell>
                <Cell num>{(point.parallelShare * 100).toFixed(1)}%</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
