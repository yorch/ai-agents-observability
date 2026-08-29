import Link from 'next/link';
import { Card, CardEmpty, Cell, ChartHover, Row, Table } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { fmtDurationSec, fmtUsdSession } from '@/lib/fmt';
import type { CostDurationPoint } from '@/lib/scatter-queries';

export async function CostDurationScatter({
  points,
  aggregate = false,
  drilldownHref,
}: {
  points: CostDurationPoint[];
  aggregate?: boolean;
  drilldownHref?: string | undefined;
}) {
  const { dict } = await getTranslations();
  if (points.length === 0) {
    return (
      <Card title={dict.org.scatter.title} caption={dict.org.scatter.caption}>
        <CardEmpty>{dict.org.scatter.empty}</CardEmpty>
      </Card>
    );
  }
  const maxCost = Math.max(...points.map((p) => p.costUsd), 0.01);
  const maxDuration = Math.max(...points.map((p) => p.durationSeconds), 60);
  return (
    <Card
      title={dict.org.scatter.title}
      caption={aggregate ? dict.org.scatter.aggregateCaption : dict.org.scatter.sessionCaption}
    >
      <ChartHover>
        <div
          className="relative h-64 border-b border-l border-border pl-8"
          role="img"
          aria-label={dict.org.scatter.aria}
        >
          <span className="absolute left-0 bottom-1 text-[10px] text-text-3">$0</span>
          <span className="absolute left-0 top-0 text-[10px] text-text-3">
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
        <summary className="cursor-pointer text-text-3">{dict.org.scatter.viewData}</summary>
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
      {drilldownHref && (
        <Link className="mt-3 inline-block text-sm text-accent underline" href={drilldownHref}>
          {dict.org.scatter.exploreMatching}
        </Link>
      )}
    </Card>
  );
}
