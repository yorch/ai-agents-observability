import { Card, Cell, foldToSeries, Legend, Row, seriesBg, Table } from '@/components/ui';

type ModelEntry = { costUsd: number; model: string; sessionCount: number; turns: number };

export function ModelMixChart({ models }: { models: ModelEntry[] }) {
  if (models.length === 0) {
    return (
      <Card title="Model usage">
        <p className="text-sm text-text-3">No model activity in this period.</p>
      </Card>
    );
  }

  const totalTurns = Math.max(
    models.reduce((sum, m) => sum + m.turns, 0),
    1,
  );

  // The query is unbounded, and past six models the palette would start
  // repeating — the tail folds into one "Other" row instead.
  const shown = foldToSeries(models, (tail) => ({
    costUsd: tail.reduce((sum, m) => sum + m.costUsd, 0),
    model: `Other (${tail.length})`,
    sessionCount: tail.reduce((sum, m) => sum + m.sessionCount, 0),
    turns: tail.reduce((sum, m) => sum + m.turns, 0),
  }));

  return (
    <Card title="Model usage" caption="Share of turns">
      {/* Segmented bar, proportional to turns. Models are separate entities, so
          they take the series palette — the accent shaded three ways could not
          tell them apart. A hairline gap keeps adjacent segments distinct. */}
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2">
        {shown.map((m, i) => (
          <span
            key={m.model}
            className={seriesBg(i)}
            style={{ width: `${(m.turns / totalTurns) * 100}%` }}
            title={`${m.model}: ${m.turns.toLocaleString()} turns`}
          />
        ))}
      </div>
      <Legend items={shown.map((m, index) => ({ index, label: m.model }))} />

      <div className="mt-4">
        <Table
          columns={[
            { label: 'Model' },
            { align: 'right', label: 'Turns', mono: true },
            { align: 'right', label: 'Sessions', mono: true },
            { align: 'right', label: 'Cost', mono: true },
          ]}
        >
          {shown.map((m, i) => (
            <Row key={m.model}>
              <Cell>
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-sm ${seriesBg(i)}`} />
                  <span className="truncate text-text-2">{m.model}</span>
                </span>
              </Cell>
              <Cell num>{m.turns.toLocaleString()}</Cell>
              <Cell num>{m.sessionCount}</Cell>
              <Cell num>${m.costUsd.toFixed(3)}</Cell>
            </Row>
          ))}
        </Table>
      </div>
    </Card>
  );
}
