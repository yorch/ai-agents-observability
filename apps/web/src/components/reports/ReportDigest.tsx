import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { ButtonLink, Card, Cell, Row, Table } from '@/components/ui';
import { type ReportDigest as Digest, formatReportDelta } from '@/lib/reporting';
import type { CostDurationPoint } from '@/lib/scatter-queries';
import type { ActivityHeatmapCell, ConcurrencyPoint, ScopedTrendPoint } from '@/lib/trend-queries';

function value(value: number, unit: Digest['metrics'][number]['unit']): string {
  if (unit === 'usd') {
    return `$${value.toFixed(2)}`;
  }
  if (unit === 'hours') {
    return `${value.toFixed(1)}h`;
  }
  if (unit === 'percent') {
    return `${value.toFixed(1)}%`;
  }
  return Math.round(value).toLocaleString();
}

export function ReportDigest({
  apiHref,
  report,
  trends = [],
  scatter,
  aggregateScatter = false,
  concurrency = [],
  heatmap = [],
  drilldownHref,
}: {
  apiHref: string;
  report: Digest;
  trends?: ScopedTrendPoint[];
  scatter?: CostDurationPoint[];
  aggregateScatter?: boolean;
  concurrency?: ConcurrencyPoint[];
  heatmap?: ActivityHeatmapCell[];
  drilldownHref?: string | undefined;
}) {
  const topModelCost = report.topModels.reduce((sum, row) => sum + row.costUsd, 0);
  const leadModel = report.topModels[0];
  const leadShare = topModelCost > 0 && leadModel ? leadModel.costUsd / topModelCost : 0;
  const largestChange = report.metrics
    .map((metric) => ({ delta: metric.current - metric.prior, metric }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`${apiHref}&format=md`} size="sm" variant="secondary">
          Download Markdown
        </ButtonLink>
        <ButtonLink href={`${apiHref}&format=csv`} size="sm" variant="secondary">
          Download CSV
        </ButtonLink>
        <ButtonLink href={`${apiHref}&format=json`} size="sm" variant="secondary">
          Download JSON
        </ButtonLink>
        <ButtonLink href={`${apiHref}&format=bundle`} size="sm" variant="secondary">
          Download report bundle
        </ButtonLink>
      </div>
      <Card
        title="Period summary"
        caption={`Trailing ${report.period.days}-day period · compared with the preceding ${report.period.days} days`}
        flush
      >
        <Table
          columns={[
            { label: 'Metric' },
            { align: 'right', label: 'This period' },
            { align: 'right', label: 'Prior' },
            { align: 'right', label: 'Change' },
          ]}
        >
          {report.metrics.map((metric) => (
            <Row key={metric.label}>
              <Cell>{metric.label}</Cell>
              <Cell num>{value(metric.current, metric.unit)}</Cell>
              <Cell num>{value(metric.prior, metric.unit)}</Cell>
              <Cell num>{formatReportDelta(metric)}</Cell>
            </Row>
          ))}
        </Table>
      </Card>
      <Card
        title="Readout highlights"
        caption="Signals worth carrying into the next planning conversation"
      >
        {largestChange ? (
          <div className="grid gap-4 text-sm md:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wider text-text-3">Largest movement</p>
              <p className="mt-1 text-text">
                {largestChange.metric.label}: {formatReportDelta(largestChange.metric)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-text-3">Model concentration</p>
              <p className="mt-1 text-text">
                {leadModel && topModelCost > 0
                  ? `${leadModel.model} accounts for ${(leadShare * 100).toFixed(0)}% of the top-model spend.`
                  : 'No model spend is recorded in this period.'}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-text-2">No changes are available for this period.</p>
        )}
      </Card>
      {trends.length > 0 && (
        <ScopedTrendCharts
          aggregateScatter={aggregateScatter}
          concurrency={concurrency}
          heatmap={heatmap}
          points={trends}
          scatter={scatter ?? []}
          drilldownHref={drilldownHref}
        />
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Top models" flush>
          <Table
            columns={[
              { label: 'Model' },
              { align: 'right', label: 'Sessions' },
              { align: 'right', label: 'Cost' },
            ]}
          >
            {report.topModels.map((model) => (
              <Row key={model.model}>
                <Cell>{model.model}</Cell>
                <Cell num>{model.sessions.toLocaleString()}</Cell>
                <Cell num>${model.costUsd.toFixed(2)}</Cell>
              </Row>
            ))}
          </Table>
        </Card>
        <Card title="Top tools" flush>
          <Table columns={[{ label: 'Tool' }, { align: 'right', label: 'Calls' }]}>
            {report.topTools.map((tool) => (
              <Row key={tool.name}>
                <Cell>{tool.name}</Cell>
                <Cell num>{tool.calls.toLocaleString()}</Cell>
              </Row>
            ))}
          </Table>
        </Card>
      </div>
      <Card title="Report notes">
        <ul className="list-disc space-y-1 pl-5 text-sm text-text-2">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
