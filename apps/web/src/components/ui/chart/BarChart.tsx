import { ChartHover } from './ChartHover';
import { Legend } from './Legend';
import { axisTicks, niceMax, seriesBg } from './scale';

export type BarDatum = { label: string; values: number[] };

/**
 * Vertical bars over a categorical axis — one series or several, stacked.
 *
 * Laid out in HTML rather than SVG: a scaled SVG would blow its type up with
 * the container (a 560-unit viewBox in a 900px card renders 9px labels at 15px)
 * and clip the top tick. Here the plot has a fixed pixel height, the bars take
 * percentage heights, and every label is real text at its real size.
 *
 * Server-rendered — interactivity comes from the ChartHover wrapper reading
 * `data-tip` off each mark.
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

  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const top = niceMax(Math.max(...totals));
  const ticks = axisTicks(top).reverse();
  // Past ~16 bars the labels collide, so thin them rather than shrink them.
  const labelEvery = Math.ceil(data.length / 16);

  return (
    <>
      <ChartHover>
        <div className="flex gap-2">
          {/* Y axis. Each label is positioned at the same percentage as its
              gridline rather than distributed, so the two always agree. */}
          <div className="relative h-44 w-10 shrink-0">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute right-0 -translate-y-1/2 font-mono text-[10px] text-text-3"
                style={{ top: `${(1 - t / top) * 100}%` }}
              >
                {format(t)}
              </span>
            ))}
          </div>

          <div className="min-w-0 flex-1">
            <div className="relative h-44">
              {/* Gridlines sit behind the bars and stay recessive. */}
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute inset-x-0 border-t border-grid"
                  style={{ top: `${(1 - t / top) * 100}%` }}
                />
              ))}

              <div className="absolute inset-0 flex items-end gap-1">
                {data.map((d, i) => {
                  const total = totals[i] ?? 0;
                  return (
                    // One full-width slot per period keeps bars aligned with their
                    // axis labels; the bar inside is capped so a short series
                    // draws bars rather than slabs.
                    <div
                      key={d.label}
                      className="flex h-full min-w-0 flex-1 items-end justify-center"
                    >
                      {/* column-reverse stacks the first series at the base, so
                        the values can be walked forward. */}
                      <div
                        className="flex w-full max-w-7 flex-col-reverse"
                        style={{ height: `${(total / top) * 100}%` }}
                      >
                        {d.values.map((v, s) => {
                          const share = total ? (v / total) * 100 : 0;
                          if (share <= 0) {
                            return null;
                          }
                          const isTop = s === d.values.length - 1;
                          return (
                            <span
                              key={series[s] ?? s}
                              className={`block ${seriesBg(s)}${isTop ? ' rounded-t-[3px]' : ''}${
                                s > 0 ? ' mb-[1.5px]' : ''
                              }`}
                              style={{ height: `${share}%` }}
                              data-tip={`${d.label} · ${series[s] ?? ''}|${format(v)}`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-1.5 flex gap-[2px]">
              {data.map((d, i) => (
                <span
                  key={d.label}
                  className="min-w-0 flex-1 truncate text-center font-mono text-[10px] text-text-3"
                >
                  {i % labelEvery === 0 ? d.label : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
      </ChartHover>
      <Legend items={series.map((label, index) => ({ index, label }))} />
    </>
  );
}
