import { BarChart, Card, Cell, HBars, Row, Table } from '@/components/ui';
import { fmtPct, fmtUsdSession } from '@/lib/fmt';
import type { SessionVisualPoint } from '@/lib/sessions-queries';

function tokens(value: number): string {
  return value.toLocaleString();
}

/**
 * Numeric session observability, deliberately separate from the transcript
 * and judge surfaces. It shows only aggregates already present in telemetry.
 */
export function SessionVisuals({ points }: { points: SessionVisualPoint[] }) {
  if (points.length === 0) {
    return null;
  }

  const modelTotals = new Map<string, number>();
  let cacheRead = 0;
  let input = 0;
  let cumulative = 0;
  for (const point of points) {
    const model = point.model ?? 'Unknown model';
    modelTotals.set(model, (modelTotals.get(model) ?? 0) + point.costUsd);
    cacheRead += point.cacheReadTokens;
    input += point.inputTokens;
    cumulative += point.costUsd;
  }

  const models = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({ display: fmtUsdSession(value), index, label, value }));
  const cacheDenom = input + cacheRead;
  const cacheShare = cacheDenom > 0 ? cacheRead / cacheDenom : null;
  const hasTools = points.some((point) => point.toolCalls > 0);
  const hasSubagents = points.some((point) => point.subagentCalls > 0);

  return (
    <section aria-labelledby="session-visuals-title" className="space-y-4">
      <div>
        <h2 id="session-visuals-title" className="font-display text-lg font-semibold text-text">
          Session analysis
        </h2>
        <p className="mt-1 text-sm text-text-2">
          Per-turn telemetry aggregates. Input tokens indicate context load; a model context-window
          limit is not reported by every agent, so pressure is shown without an invented percentage.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Cost by turn"
          caption="Bars show incremental cost; the table provides the cumulative total."
        >
          <BarChart
            data={points.map((point) => ({ label: `T${point.turn}`, values: [point.costUsd] }))}
            format={fmtUsdSession}
            series={['Cost']}
          />
          <Table
            columns={[
              { label: 'Turn' },
              { align: 'right', label: 'Cost', mono: true },
              { align: 'right', label: 'Cumulative', mono: true },
            ]}
          >
            {points.map((point) => {
              const before = points
                .slice(0, points.indexOf(point))
                .reduce((sum, item) => sum + item.costUsd, 0);
              return (
                <Row key={point.turn}>
                  <Cell>T{point.turn}</Cell>
                  <Cell num>{fmtUsdSession(point.costUsd)}</Cell>
                  <Cell num>{fmtUsdSession(before + point.costUsd)}</Cell>
                </Row>
              );
            })}
          </Table>
        </Card>

        <Card
          title="Context and cache"
          caption="Cache read share is calculated from input plus cache-read tokens."
        >
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex justify-between text-sm">
                <span className="text-text-2">Cache read share</span>
                <span className="font-mono text-text">
                  {cacheShare == null ? '—' : fmtPct(cacheShare, 1)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-r-full bg-series-2"
                  style={{ width: `${(cacheShare ?? 0) * 100}%` }}
                />
              </div>
            </div>
            <Table
              columns={[
                { label: 'Turn' },
                { align: 'right', label: 'Input', mono: true },
                { align: 'right', label: 'Cache read', mono: true },
                { align: 'right', label: 'Cache write', mono: true },
              ]}
            >
              {points.map((point) => (
                <Row key={point.turn}>
                  <Cell>T{point.turn}</Cell>
                  <Cell num>{tokens(point.inputTokens)}</Cell>
                  <Cell num>{tokens(point.cacheReadTokens)}</Cell>
                  <Cell num>{tokens(point.cacheCreationTokens)}</Cell>
                </Row>
              ))}
            </Table>
          </div>
        </Card>

        {hasTools && (
          <Card title="Tool activity" caption="Tool calls and errors by turn.">
            <BarChart
              data={points.map((point) => ({
                label: `T${point.turn}`,
                values: [point.toolCalls - point.toolErrors, point.toolErrors],
              }))}
              format={(value) => value.toLocaleString()}
              series={['Successful calls', 'Errors']}
            />
          </Card>
        )}

        <Card title="Model mix" caption="Cost share by model in this session.">
          <HBars rows={models} tinted />
          <Table columns={[{ label: 'Model' }, { align: 'right', label: 'Cost', mono: true }]}>
            {models.map((model) => (
              <Row key={model.label}>
                <Cell>{model.label}</Cell>
                <Cell num>{model.display}</Cell>
              </Row>
            ))}
          </Table>
        </Card>

        {hasSubagents && (
          <Card title="Subagent bursts" caption="Subagent-bearing events by turn.">
            <BarChart
              data={points.map((point) => ({
                label: `T${point.turn}`,
                values: [point.subagentCalls],
              }))}
              format={(value) => value.toLocaleString()}
              series={['Subagent events']}
            />
          </Card>
        )}
      </div>
      <p className="text-xs text-text-3">
        Total observed cost: {fmtUsdSession(cumulative)}. Missing token fields are shown as zero by
        the ingestion contract.
      </p>
    </section>
  );
}
