import type { ShapeLabel } from '@ai-agents-observability/schemas';

import { SeriesBadge, seriesBg } from '@/components/ui';
import { shapeSeriesIndex } from '@/lib/effectiveness';

/**
 * Session-shape presentation, in one place.
 *
 * `lib/effectiveness.ts` owns the shape → series-index mapping; this turns it
 * into a fill or a badge. Two copies of a private `SHAPE_COLOR` map used to
 * live in the chart components and had already drifted apart — `exploratory`
 * and `planning` both resolved to the same hue, and `debugging` borrowed a
 * status tone for what is a category.
 */
export function shapeBg(label: string): string {
  const index = shapeSeriesIndex(label as ShapeLabel);
  return index === null ? 'bg-surface-2' : seriesBg(index);
}

export function ShapeBadge({ label }: { label: string | null }) {
  if (!label) {
    return <span className="text-text-3">—</span>;
  }
  return <SeriesBadge index={shapeSeriesIndex(label as ShapeLabel)}>{label}</SeriesBadge>;
}
