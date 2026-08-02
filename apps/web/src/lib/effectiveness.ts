import type { ShapeLabel } from '@ai-agents-observability/schemas';

import { FRICTION_BAND_HIGH, FRICTION_BAND_LOW } from '@ai-agents-observability/schemas';

import type { Tone } from './tone';

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

/**
 * Friction is a severity scale, so it takes the status tones. Returning the
 * tone rather than a class string keeps this module free of Tailwind classes —
 * the caller renders a `Badge`.
 */
export function frictionBadge(score: number): { label: string; tone: Tone } {
  if (score < FRICTION_BAND_LOW) {
    return { label: 'Low', tone: 'good' };
  }
  if (score <= FRICTION_BAND_HIGH) {
    return { label: 'Medium', tone: 'warn' };
  }
  return { label: 'High', tone: 'crit' };
}

/**
 * Session shapes are a categorical set, not a severity scale, so they take
 * fixed series indices — a shape keeps its colour whatever else is on screen.
 */
// `minimal` is the absence of a shape, so it stays neutral rather than
// claiming a series colour.
const SHAPE_SERIES_INDEX: Record<ShapeLabel, number | null> = {
  debugging: 1,
  exploratory: 0,
  'focused-edit': 2,
  minimal: null,
  'multi-tool': 3,
  planning: 5,
};

export function shapeSeriesIndex(label: ShapeLabel): number | null {
  return SHAPE_SERIES_INDEX[label] ?? null;
}
