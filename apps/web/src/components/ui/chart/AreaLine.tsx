import { fmtFriction } from '@/lib/fmt';
import { ChartHover } from './ChartHover';

const W = 320;
const H = 80;
/** The fixed 0–1 domain, gridded at its ends and midpoint. */
const GRID = [1, 0.5, 0] as const;

const clamp = (v: number) => Math.min(Math.max(v, 0), 1);

/**
 * A single 0–1 series over time, drawn as a line with a soft area fill.
 *
 * Used for the friction trends, which share the same fixed domain and the same
 * three-part footer. `preserveAspectRatio="none"` is deliberate here: there is
 * no text inside the viewBox to distort, and letting the plot stretch to the
 * card's width is the point. Because the SVG stretches, the point marks are
 * HTML positioned by percentage on top of it rather than SVG circles, which
 * would be squashed into ellipses.
 *
 * Every point is a focusable mark carrying `data-tip`, so each value is
 * reachable by hover and by keyboard — a line with no readable values is a
 * picture, not a chart.
 */
export function AreaLine({
  ariaLabel,
  endLabel,
  format = fmtFriction,
  midLabel,
  pointLabels,
  points,
  startLabel,
}: {
  ariaLabel: string;
  endLabel: string;
  /** Formats the tooltip value and the gridline labels. Friction's 2dp by default. */
  format?: (v: number) => string;
  /** Centred caption naming the measure and its domain. */
  midLabel: string;
  /**
   * One label per point (a date, a week start) for its tooltip and aria-label.
   * Without it the marks are numbered.
   */
  pointLabels?: string[];
  /** Values in [0, 1]; anything outside is clamped. */
  points: number[];
  startLabel: string;
}) {
  const n = points.length;
  const xPct = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const x = (i: number) => (xPct(i) / 100) * W;
  const y = (v: number) => H - clamp(v) * H;
  const line = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${H.toFixed(1)} L${x(0).toFixed(1)},${H.toFixed(1)} Z`;

  return (
    <>
      <ChartHover>
        <div className="flex gap-2">
          {/* Y axis: the domain's ends and midpoint, at their gridlines. */}
          <div className="relative h-20 w-8 shrink-0" aria-hidden="true">
            {GRID.map((t) => (
              <span
                key={t}
                className="absolute right-0 -translate-y-1/2 font-mono text-[10px] text-text-3"
                style={{ top: `${(1 - t) * 100}%` }}
              >
                {format(t)}
              </span>
            ))}
          </div>

          <div className="relative h-20 min-w-0 flex-1">
            {GRID.map((t) => (
              <span
                key={t}
                className="absolute inset-x-0 border-t border-grid"
                style={{ top: `${(1 - t) * 100}%` }}
              />
            ))}
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="absolute inset-0 h-full w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={ariaLabel}
            >
              <path d={area} className="fill-accent-soft" />
              <path
                d={line}
                className="fill-none stroke-accent"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {points.map((v, i) => {
              const label = pointLabels?.[i] ?? `Point ${i + 1}`;
              const text = format(v);
              return (
                // A 20px hit area around a 6px dot: the marks are the only way
                // to read a value, so they have to be easy to land on.
                <span
                  key={i}
                  role="img"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip value must be reachable by keyboard, not hover-only (WCAG 1.4.13 / 2.1.1)
                  tabIndex={0}
                  aria-label={`${label}: ${text}`}
                  data-tip={`${label}|${text}`}
                  className="group absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-offset-0 focus-visible:outline-2 focus-visible:outline-accent"
                  style={{ left: `${xPct(i)}%`, top: `${(1 - clamp(v)) * 100}%` }}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-accent transition-transform group-hover:scale-150" />
                </span>
              );
            })}
          </div>
        </div>
      </ChartHover>
      <div className="mt-2 ml-10 flex justify-between gap-3 text-[10px] text-text-3">
        <span>{startLabel}</span>
        <span className="text-center">{midLabel}</span>
        <span className="text-right">{endLabel}</span>
      </div>
    </>
  );
}
