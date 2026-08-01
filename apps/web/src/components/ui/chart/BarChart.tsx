import { ChartHover } from './ChartHover';
import { Legend } from './Legend';
import { axisTicks, niceMax, seriesFill } from './scale';

const W = 560;
const H = 190;
const PAD_B = 22;
const PAD_L = 46;
const PLOT_H = H - PAD_B;
/** Surface-coloured gap so stacked segments read as separate marks. */
const SEG_GAP = 1.5;

export type BarDatum = { label: string; values: number[] };

/**
 * Vertical bars over a categorical axis — one series or several, stacked.
 *
 * Server-rendered: the SVG is plain markup, and interactivity comes from the
 * ChartHover wrapper reading `data-tip` off each mark.
 */
export function BarChart({
  data,
  format,
  series,
}: {
  data: BarDatum[];
  /** Formats both the axis ticks and the tooltip value. */
  format: (v: number) => string;
  /** Series names in fixed assignment order; length drives the stack depth. */
  series: string[];
}) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-text-3">No data in this period.</p>;
  }

  const top = niceMax(Math.max(...data.map((d) => d.values.reduce((a, b) => a + b, 0))));
  const slot = (W - PAD_L) / data.length;
  const barW = Math.min(26, Math.max(4, slot - 9));
  // Label every bar when they fit, otherwise every other one.
  const labelEvery = slot < 34 ? 2 : 1;

  return (
    <>
      <ChartHover>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Bar chart of ${series.join(', ')} across ${data.length} periods`}
        >
          <title>{`${series.join(', ')} by period`}</title>
          {axisTicks(top).map((t) => {
            const y = PLOT_H - (t / top) * PLOT_H;
            return (
              <g key={t}>
                <line x1={PAD_L} x2={W} y1={y} y2={y} className="stroke-grid" strokeWidth={1} />
                <text
                  x={PAD_L - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  className="fill-text-3 font-mono"
                  fontSize={9.5}
                >
                  {format(t)}
                </text>
              </g>
            );
          })}

          {data.map((d, i) => {
            const x = PAD_L + i * slot + (slot - barW) / 2;
            let acc = 0;
            return (
              <g key={d.label}>
                {d.values.map((v, s) => {
                  const h = (v / top) * PLOT_H;
                  const y = PLOT_H - h - acc;
                  acc += h;
                  if (h <= 0) {
                    return null;
                  }
                  const isTop = s === d.values.length - 1;
                  const gap = s > 0 ? SEG_GAP : 0;
                  return (
                    <rect
                      key={series[s] ?? s}
                      x={x}
                      y={y + gap}
                      width={barW}
                      height={Math.max(0, h - gap)}
                      rx={isTop ? 4 : 0}
                      className={seriesFill(s)}
                      data-tip={`${d.label} · ${series[s] ?? ''}|${format(v)}`}
                    />
                  );
                })}
                {i % labelEvery === 0 && (
                  <text
                    x={x + barW / 2}
                    y={H - 6}
                    textAnchor="middle"
                    className="fill-text-3 font-mono"
                    fontSize={9.5}
                  >
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </ChartHover>
      <Legend items={series.map((label, index) => ({ index, label }))} />
    </>
  );
}
