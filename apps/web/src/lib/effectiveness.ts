/**
 * Phase 5 — Effectiveness signals.
 *
 * Friction score: composite metric [0, 1] from denial rate, error rate,
 * interrupt rate, and early-abandonment signal. Higher = more friction.
 * Weights are tunable; version pinned so dashboards don't silently change.
 */

export const FRICTION_VERSION = 1;

type FrictionInputs = {
  durationSeconds: number | null;
  interruptCount: number;
  permissionDenyCount: number;
  status: string;
  toolCallCount: number;
  toolErrorCount: number;
  userMessageCount: number;
};

/**
 * Compute friction score from session aggregate fields.
 * Returns a value in [0, 1]; null if there is insufficient data
 * (< 2 tool calls and < 2 user messages — the session barely started).
 */
export function computeFrictionScore(inputs: FrictionInputs): number | null {
  const {
    durationSeconds,
    interruptCount,
    permissionDenyCount,
    status,
    toolCallCount,
    toolErrorCount,
    userMessageCount,
  } = inputs;

  if (toolCallCount < 2 && userMessageCount < 2) {
    return null;
  }

  // Normalised per-signal [0,1]
  const denyRate = toolCallCount > 0 ? Math.min(permissionDenyCount / toolCallCount, 1) : 0;
  const errorRate = toolCallCount > 0 ? Math.min(toolErrorCount / toolCallCount, 1) : 0;
  const interruptRate = userMessageCount > 0 ? Math.min(interruptCount / userMessageCount, 1) : 0;
  // Short abandonment: < 60 s and status=abandoned → high friction
  const shortAbandoned =
    status === 'abandoned' && (durationSeconds == null || durationSeconds < 60) ? 1 : 0;

  // Weighted sum (weights sum to 1)
  const score = denyRate * 0.3 + errorRate * 0.3 + interruptRate * 0.25 + shortAbandoned * 0.15;

  return Math.min(1, score);
}

/**
 * Session shape classification based on tool histogram.
 * Returns a human-readable label and confidence [0,1].
 */
export type ShapeLabel =
  | 'exploratory' // heavy Read/Glob/Grep, few writes
  | 'focused-edit' // heavy Edit/Write, clear target
  | 'debugging' // heavy Bash + errors, many retries
  | 'planning' // mostly user messages + no file writes
  | 'multi-tool' // broad tool spread; no dominant pattern
  | 'minimal'; // very few events — not enough to classify

type ToolHistogram = {
  callCount: number;
  toolName: string;
}[];

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const EXEC_TOOLS = new Set(['Bash', 'Exec', 'Shell']);

export function classifySessionShape(
  histogram: ToolHistogram,
  userMessageCount: number,
  toolCallCount: number,
): ShapeLabel {
  if (toolCallCount < 3 && userMessageCount < 3) {
    return 'minimal';
  }

  const total = histogram.reduce((s, r) => s + r.callCount, 0);
  if (total === 0) {
    return userMessageCount > 3 ? 'planning' : 'minimal';
  }

  const readCalls = histogram
    .filter((r) => READ_TOOLS.has(r.toolName))
    .reduce((s, r) => s + r.callCount, 0);
  const writeCalls = histogram
    .filter((r) => WRITE_TOOLS.has(r.toolName))
    .reduce((s, r) => s + r.callCount, 0);
  const execCalls = histogram
    .filter((r) => EXEC_TOOLS.has(r.toolName))
    .reduce((s, r) => s + r.callCount, 0);

  const readFrac = readCalls / total;
  const writeFrac = writeCalls / total;
  const execFrac = execCalls / total;

  if (readFrac > 0.6 && writeFrac < 0.15) {
    return 'exploratory';
  }
  if (writeFrac > 0.5) {
    return 'focused-edit';
  }
  if (execFrac > 0.4 && writeFrac < 0.2) {
    return 'debugging';
  }
  if (userMessageCount > 0.7 * (toolCallCount + userMessageCount)) {
    return 'planning';
  }

  return 'multi-tool';
}

/** Badge color for friction score. */
export function frictionBadge(score: number): {
  color: string;
  label: string;
} {
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
