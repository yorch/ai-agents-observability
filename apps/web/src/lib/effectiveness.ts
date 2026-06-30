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

/** Badge color for friction score. */
export function frictionBadge(score: number): { color: string; label: string } {
  if (score < 0.2) {
    return { color: 'text-green-400', label: 'Low' };
  }
  if (score < 0.5) {
    return { color: 'text-yellow-400', label: 'Medium' };
  }
  return { color: 'text-red-400', label: 'High' };
}

/** Badge color for shape label. */
export function shapeBadge(label: ShapeLabel): string {
  const map: Record<ShapeLabel, string> = {
    debugging: 'bg-orange-500/20 text-orange-300',
    exploratory: 'bg-blue-500/20 text-blue-300',
    'focused-edit': 'bg-green-500/20 text-green-300',
    minimal: 'bg-white/10 text-white/40',
    'multi-tool': 'bg-purple-500/20 text-purple-300',
    planning: 'bg-sky-500/20 text-sky-300',
  };
  return map[label] ?? 'bg-white/10 text-white/40';
}
