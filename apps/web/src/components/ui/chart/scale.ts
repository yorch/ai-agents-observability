// Shared chart maths. Every chart in the app derives its geometry here so
// axes, gridlines and bar widths stay consistent across pages.

/** The six categorical series, in fixed assignment order. */
export const SERIES_CLASS = [
  'fill-series-1',
  'fill-series-2',
  'fill-series-3',
  'fill-series-4',
  'fill-series-5',
  'fill-series-6',
] as const;

export const SERIES_BG = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
  'bg-series-6',
] as const;

export const SERIES_COUNT = SERIES_CLASS.length;

/**
 * Colour follows the entity, never its rank — so callers pass a stable index
 * (position in the canonical entity list), not the sorted position. Anything
 * past the sixth entity folds into "Other" rather than inventing a hue.
 */
export function seriesFill(index: number): string {
  return SERIES_CLASS[Math.min(index, SERIES_COUNT - 1)] ?? SERIES_CLASS[0];
}

export function seriesBg(index: number): string {
  return SERIES_BG[Math.min(index, SERIES_COUNT - 1)] ?? SERIES_BG[0];
}

/**
 * Rounds an axis maximum up to a readable step so gridlines land on values a
 * person would choose (250, 500, 1k) rather than on the data's exact peak.
 */
export function niceMax(max: number, ticks = 4): number {
  if (max <= 0) {
    return 1;
  }
  const rough = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag * ticks;
}

export function axisTicks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

/** Compact money for axis labels: 0 · $250 · $1.2k · $18k. */
export function axisMoney(v: number): string {
  if (v === 0) {
    return '0';
  }
  if (v >= 1000) {
    const k = v / 1000;
    return `$${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `$${Math.round(v)}`;
}

export function axisCount(v: number): string {
  if (v === 0) {
    return '0';
  }
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(Math.round(v));
}
