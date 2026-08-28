import { Card, CardEmpty, Cell, ChartHover, Row, Table } from '@/components/ui';
import { fmtDurationSec, fmtUsdSession } from '@/lib/fmt';
import type { CostDurationPoint } from '@/lib/scatter-queries';

export function CostDurationScatter({
  points,
  aggregate = false,
}: {
  points: CostDurationPoint[];
  aggregate?: boolean;
}) {
  if (points.length === 0) {
    return (
      <Card title="Cost vs duration" caption="Completed sessions in this period">
        <CardEmpty>No completed sessions in this period.</CardEmpty>
      </Card>
    );
  }
  const maxCost = Math.max(...points.map((p) => p.costUsd), 0.01);
  const maxDuration = Math.max(...points.map((p) => p.durationSeconds), 60);
  return (
    <Card
      title="Cost vs duration"
      caption={
        aggregate
          ? 'Aggregate buckets · each mark represents one or more sessions'
          : 'Completed sessions · longer or more expensive sessions sit higher and farther right'
      }
    >
      <ChartHover>
        <div
          className="relative h-64 border-b border-l border-border"
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
            const left = (point.durationSeconds / maxDuration) * 100;
            const bottom = (point.costUsd / maxCost) * 100;
            const label = `${fmtDurationSec(point.durationSeconds)} · ${fmtUsdSession(point.costUsd)}${point.sessionCount > 1 ? ` · ${point.sessionCount} sessions` : ''}`;
            return (
              <span
                key={`${point.durationSeconds}-${point.costUsd}-${index}`}
                role="img"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: chart marks need keyboard tooltip parity
                tabIndex={0}
                aria-label={label}
                data-tip={`${fmtDurationSec(point.durationSeconds)}|${fmtUsdSession(point.costUsd)}${point.sessionCount > 1 ? ` (${point.sessionCount})` : ''}`}
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
            { align: 'right', label: 'Cost' },
            { align: 'right', label: 'Sessions' },
          ]}
        >
          {points.map((point, index) => (
            <Row key={`${point.durationSeconds}-${point.costUsd}-${index}`}>
              <Cell>{fmtDurationSec(point.durationSeconds)}</Cell>
              <Cell num>{fmtUsdSession(point.costUsd)}</Cell>
              <Cell num>{point.sessionCount.toLocaleString()}</Cell>
            </Row>
          ))}
        </Table>
      </details>
    </Card>
  );
}
