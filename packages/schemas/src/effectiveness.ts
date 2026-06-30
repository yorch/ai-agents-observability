/**
 * Effectiveness signals shared between apps/ingest (nightly compute job)
 * and apps/web (dashboard display).
 *
 * Friction score: composite metric [0, 1] from denial rate, error rate,
 * interrupt rate, and early-abandonment signal. Higher = more friction.
 * Weights are tunable; version pinned so dashboards don't silently change.
 */

export const FRICTION_VERSION = 1;

export type FrictionInputs = {
  durationSeconds: number | null;
  interruptCount: number;
  permissionDenyCount: number;
  status: string;
  toolCallCount: number;
  toolErrorCount: number;
  userMessageCount: number;
};

// Weights of each friction component, summed (then capped at 1) for the score.
// Single source of truth for both computeFrictionScore and frictionComponents.
export const FRICTION_WEIGHTS = {
  abandonment: 0.15,
  denial: 0.3,
  error: 0.3,
  interrupt: 0.25,
} as const;

// The weighted contribution of each friction driver. Summing the four equals the
// pre-cap friction score, so this is a faithful decomposition of "what drove the
// friction" — used to surface top friction sources and recommendations (Feature 5).
export type FrictionComponents = {
  abandonment: number;
  denial: number;
  error: number;
  interrupt: number;
};

export function frictionComponents(inputs: FrictionInputs): FrictionComponents | null {
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

  const denyRate = toolCallCount > 0 ? Math.min(permissionDenyCount / toolCallCount, 1) : 0;
  const errorRate = toolCallCount > 0 ? Math.min(toolErrorCount / toolCallCount, 1) : 0;
  const interruptRate = userMessageCount > 0 ? Math.min(interruptCount / userMessageCount, 1) : 0;
  const shortAbandoned =
    status === 'ABANDONED' && (durationSeconds == null || durationSeconds < 60) ? 1 : 0;

  return {
    abandonment: shortAbandoned * FRICTION_WEIGHTS.abandonment,
    denial: denyRate * FRICTION_WEIGHTS.denial,
    error: errorRate * FRICTION_WEIGHTS.error,
    interrupt: interruptRate * FRICTION_WEIGHTS.interrupt,
  };
}

export function computeFrictionScore(inputs: FrictionInputs): number | null {
  const c = frictionComponents(inputs);
  if (c === null) {
    return null;
  }
  return Math.min(1, c.abandonment + c.denial + c.error + c.interrupt);
}

export type ShapeLabel =
  | 'exploratory' // heavy Read/Glob/Grep, few writes
  | 'focused-edit' // heavy Edit/Write, clear target
  | 'debugging' // heavy Bash + errors, many retries
  | 'planning' // mostly user messages + no file writes
  | 'multi-tool' // broad tool spread; no dominant pattern
  | 'minimal'; // very few events — not enough to classify

export type ToolHistogram = { callCount: number; toolName: string }[];

export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch']);
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
export const EXEC_TOOLS = new Set(['Bash', 'Exec', 'Shell']);

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
