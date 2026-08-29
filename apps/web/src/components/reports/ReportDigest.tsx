import { ScopedTrendCharts } from '@/components/team-org/ScopedTrendCharts';
import { ButtonLink, Card, Cell, Row, Table } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
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

export async function ReportDigest({
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
  const { dict } = await getTranslations();
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
          {dict.report.downloadMd}
        </ButtonLink>
        <ButtonLink href={`${apiHref}&format=csv`} size="sm" variant="secondary">
          {dict.report.downloadCsv}
        </ButtonLink>
        <ButtonLink href={`${apiHref}&format=json`} size="sm" variant="secondary">
          {dict.report.downloadJson}
        </ButtonLink>
        <ButtonLink href={`${apiHref}&format=bundle`} size="sm" variant="secondary">
          {dict.report.downloadBundle}
        </ButtonLink>
      </div>
      <Card
        title={dict.report.periodSummary}
        caption={format(dict.report.periodSummaryCaption, { days: report.period.days })}
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
      <Card title={dict.report.readoutHighlights} caption={dict.report.readoutHighlightsCaption}>
        {largestChange ? (
          <div className="grid gap-4 text-sm md:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wider text-text-3">
                {dict.report.largestMovement}
              </p>
              <p className="mt-1 text-text">
                {largestChange.metric.label}: {formatReportDelta(largestChange.metric)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-text-3">
                {dict.report.modelConcentration}
              </p>
              <p className="mt-1 text-text">
                {leadModel && topModelCost > 0
                  ? format(dict.report.modelConcentrationDetail, {
                      model: leadModel.model,
                      share: (leadShare * 100).toFixed(0),
                    })
                  : dict.report.noModelSpend}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-text-2">{dict.report.noChanges}</p>
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
        <Card title={dict.report.topModels} flush>
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
        <Card title={dict.report.topTools} flush>
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
      <Card title={dict.report.notes}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-text-2">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
