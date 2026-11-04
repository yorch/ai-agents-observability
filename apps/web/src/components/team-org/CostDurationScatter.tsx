import Link from 'next/link';
import { Card, CardEmpty, Cell, ChartHover, Row, Table } from '@/components/ui';
import { fmtDurationSec, fmtUsd, fmtUsdSession } from '@/lib/fmt';
import type { CostDurationPoint, ScatterPoints } from '@/lib/scatter-queries';

/** Clock-style bucket edge: 300 -> "5m", 5400 -> "1h 30m". Aggregate edges are whole minutes. */
function fmtEdge(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) {
    return `${m}m`;
  }
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Aggregate buckets are labelled by their range, never a lone edge that reads as an exact value. */
function bucketLabels(point: CostDurationPoint, aggregate: boolean) {
  if (!aggregate || !point.durationStepSeconds || !point.costStepUsd) {
    return {
      cost: fmtUsdSession(point.costUsd),
      duration: fmtDurationSec(point.durationSeconds),
    };
  }
  return {
    cost: `${fmtUsd(point.costUsd)}\u2013${fmtUsd(point.costUsd + point.costStepUsd)}`,
    duration: `${fmtEdge(point.durationSeconds)}\u2013${fmtEdge(point.durationSeconds + point.durationStepSeconds)}`,
  };
}

export function CostDurationScatter({
  points,
  aggregate = false,
  drilldownHref,
}: {
  points: CostDurationPoint[] | ScatterPoints;
  aggregate?: boolean;
  drilldownHref?: string | undefined;
}) {
  const suppressed = aggregate ? ((points as ScatterPoints).suppressedSessions ?? 0) : 0;
  const suppressedNote =
    suppressed > 0
      ? ` \u00b7 ${suppressed.toLocaleString()} ${suppressed === 1 ? 'session' : 'sessions'} in sparse buckets (fewer than 3) not shown`
      : '';
  if (points.length === 0) {
    return (
      <Card title="Cost vs duration" caption={`Completed sessions in this period${suppressedNote}`}>
        <CardEmpty>
          {suppressed > 0
            ? 'No bucket has enough sessions to show without identifying an individual.'
            : 'No completed sessions in this period.'}
        </CardEmpty>
      </Card>
    );
  }
  const costTop = (p: CostDurationPoint) => p.costUsd + (aggregate ? (p.costStepUsd ?? 0) : 0);
  const durTop = (p: CostDurationPoint) =>
    p.durationSeconds + (aggregate ? (p.durationStepSeconds ?? 0) : 0);
  const maxCost = Math.max(...points.map(costTop), 0.01);
  const maxDuration = Math.max(...points.map(durTop), 60);
  return (
    <Card
      title="Cost vs duration"
      caption={
        aggregate
          ? `Aggregate buckets \u00b7 each mark is a cost and duration range covering 3 or more sessions${suppressedNote}`
          : 'Completed sessions · longer or more expensive sessions sit higher and farther right'
      }
    >
      <ChartHover>
        <div
          className="relative ml-12 h-64 border-b border-l border-border"
          role="img"
          aria-label="Scatter plot of session cost against duration"
        >
          <span className="absolute -left-1 bottom-1 -translate-x-full text-[10px] text-text-3">
            $0
          </span>
          <span className="absolute -left-1 top-0 -translate-x-full text-[10px] text-text-3">
            {fmtUsdSession(maxCost)}
          </span>
          <span className="absolute bottom-[-1.25rem] left-0 text-[10px] text-text-3">0m</span>
          <span className="absolute bottom-[-1.25rem] right-0 text-[10px] text-text-3">
            {fmtDurationSec(maxDuration)}
          </span>
          {points.map((point, index) => {
            // Aggregate marks sit at the middle of the range they stand for.
            const left =
              ((point.durationSeconds + (aggregate ? (point.durationStepSeconds ?? 0) / 2 : 0)) /
                maxDuration) *
              100;
            const bottom =
              ((point.costUsd + (aggregate ? (point.costStepUsd ?? 0) / 2 : 0)) / maxCost) * 100;
            const text = bucketLabels(point, aggregate);
            const label = `${text.duration} · ${text.cost}${point.sessionCount > 1 ? ` · ${point.sessionCount} sessions` : ''}`;
            return (
              <span
                key={`${point.durationSeconds}-${point.costUsd}-${index}`}
                role="img"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: chart marks need keyboard tooltip parity
                tabIndex={0}
                aria-label={label}
                data-tip={`${text.duration}|${text.cost}${point.sessionCount > 1 ? ` (${point.sessionCount})` : ''}`}
                className="absolute h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full bg-accent outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
                style={{ bottom: `${bottom}%`, left: `${left}%` }}
              />
            );
          })}
        </div>
      </ChartHover>
      <details className="mt-8 text-sm text-text-2">
        <summary className="cursor-pointer text-text-3">View scatter data</summary>
        <Table
          columns={[
            { label: aggregate ? 'Duration bucket' : 'Duration' },
            { align: 'right', label: aggregate ? 'Cost bucket' : 'Cost' },
            { align: 'right', label: 'Sessions' },
          ]}
        >
          {points.map((point, index) => (
            <Row key={`${point.durationSeconds}-${point.costUsd}-${index}`}>
              <Cell>{bucketLabels(point, aggregate).duration}</Cell>
              <Cell num>{bucketLabels(point, aggregate).cost}</Cell>
              <Cell num>{point.sessionCount.toLocaleString()}</Cell>
            </Row>
          ))}
        </Table>
      </details>
      {drilldownHref && (
        <Link className="mt-3 inline-block text-sm text-accent underline" href={drilldownHref}>
          Explore matching sessions
        </Link>
      )}
    </Card>
  );
}
