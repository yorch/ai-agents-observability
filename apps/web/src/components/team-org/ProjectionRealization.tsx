import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { CardEmpty } from '@/components/ui/CardEmpty';
import { Cell, Row, Table } from '@/components/ui/Table';
import { fmtDate, fmtUsd } from '@/lib/fmt';
import type { Realization } from '@/lib/projections';

/**
 * Projected-vs-realized for a registered claim (P13-006, supersedes P10-006).
 *
 * Presentational: the page fetches the stored projections and their post-period
 * actuals and hands `realizeProjection`'s output straight in, so what is shown is
 * what the pure function decided.
 *
 * Two display rules are load-bearing rather than stylistic:
 *
 * - **A flagged realization is never presented as a win.** When outcomes for the
 *   segment degraded over the same period, the row reads as a warning no matter
 *   which way the headline number went. A saving bought with more reverts is not
 *   a saving, and rendering it in the success tone is how a product learns to
 *   trust its own bad advice.
 * - **"Not yet measurable" is a real answer.** Below the claim's volume floor the
 *   row says so instead of showing a delta computed from a handful of rows.
 */

function verdict(r: Realization): { label: string; tone: 'accent' | 'crit' | 'good' | 'neutral' } {
  if (r.status === 'period_open') {
    return { label: 'period open', tone: 'neutral' };
  }
  if (r.status === 'not_yet_measurable') {
    return { label: 'not yet measurable', tone: 'neutral' };
  }
  if (r.outcomeFlagged) {
    return { label: 'outcomes worsened', tone: 'crit' };
  }
  if (r.status === 'within_range') {
    return { label: 'as projected', tone: 'good' };
  }
  return r.wentBetterThanClaimed
    ? { label: 'better than projected', tone: 'good' }
    : { label: 'missed the projection', tone: 'accent' };
}

export function ProjectionRealization({
  caption,
  realizations,
  title,
}: {
  caption: string;
  realizations: Realization[];
  title: string;
}) {
  if (realizations.length === 0) {
    return (
      <Card title={title} caption={caption}>
        <CardEmpty>
          No projections recorded yet. Claims register themselves as they are rendered, so this
          fills in from the next page view onward — there is deliberately no backfill of claims made
          before the registry existed.
        </CardEmpty>
      </Card>
    );
  }

  return (
    <Card title={title} caption={caption} flush>
      <Table
        columns={[
          { label: 'Period' },
          { label: 'Segment' },
          { align: 'right', label: 'Projected' },
          { align: 'right', label: 'Realized' },
          { label: 'Verdict' },
        ]}
      >
        {realizations.map((r) => {
          const v = verdict(r);
          const p = r.projection;
          return (
            <Row key={p.id}>
              <Cell className="text-xs text-text-2">
                {fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}
              </Cell>
              <Cell className="font-mono text-xs">{p.segment}</Cell>
              <Cell num className="text-text-2">
                {fmtUsd(p.projectedLow)} – {fmtUsd(p.projectedHigh)}
              </Cell>
              <Cell num className="text-text">
                {r.realizedValue === null ? '—' : fmtUsd(r.realizedValue)}
              </Cell>
              <Cell>
                <div className="space-y-1">
                  <Badge tone={v.tone}>{v.label}</Badge>
                  <p className="text-[11px] leading-snug text-text-3">{r.reason}</p>
                </div>
              </Cell>
            </Row>
          );
        })}
      </Table>
    </Card>
  );
}
