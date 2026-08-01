import type { ShapeLabel } from '@ai-agents-observability/schemas';

export type {
  FrictionComponents,
  FrictionInputs,
  ShapeLabel,
  ToolHistogram,
} from '@ai-agents-observability/schemas';
export {
  classifySessionShape,
  computeFrictionScore,
  FRICTION_VERSION,
  frictionComponents,
  frictionScoreFromComponents,
} from '@ai-agents-observability/schemas';

import type { BadgeTone } from '@/components/ui/Badge';

/**
 * Friction is a severity scale, so it takes the status tones. Returning the
 * tone rather than a class string keeps this module free of Tailwind classes —
 * the caller renders a `Badge`.
 */
export function frictionBadge(score: number): { label: string; tone: BadgeTone } {
  if (score < 0.2) {
    return { label: 'Low', tone: 'good' };
  }
  if (score < 0.5) {
    return { label: 'Medium', tone: 'warn' };
  }
  return { label: 'High', tone: 'crit' };
}

/**
 * Session shapes are a categorical set, not a severity scale, so they take
 * fixed series indices — a shape keeps its colour whatever else is on screen.
 */
export function shapeSeriesIndex(label: ShapeLabel): number | null {
  const map: Record<ShapeLabel, number> = {
    debugging: 1,
    exploratory: 0,
    'focused-edit': 2,
    minimal: -1,
    'multi-tool': 3,
    planning: 5,
  };
  const index = map[label];
  // `minimal` is the absence of a shape — it stays neutral rather than
  // claiming a series colour.
  return index === undefined || index < 0 ? null : index;
}
