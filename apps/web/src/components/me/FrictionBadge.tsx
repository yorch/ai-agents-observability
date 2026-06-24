import { FRICTION_VERSION } from '@/lib/effectiveness';

// The friction inputs needed to explain what drove a session's score. Mirrors the
// fields computeFrictionScore consumes.
export type FrictionInputsLite = {
  durationSeconds: number | null;
  interruptCount: number;
  permissionDenyCount: number;
  status: string;
  toolCallCount: number;
  toolErrorCount: number;
  userMessageCount: number;
};

// Bands per P7-003: Low < 0.3, Medium 0.3–0.6, High > 0.6.
function band(score: number): { color: string; label: string } {
  if (score < 0.3) {
    return { color: 'bg-green-500/20 text-green-300', label: 'Low' };
  }
  if (score <= 0.6) {
    return { color: 'bg-yellow-500/20 text-yellow-300', label: 'Medium' };
  }
  return { color: 'bg-red-500/20 text-red-300', label: 'High' };
}

function explain(score: number, i: FrictionInputsLite): string {
  if (score < 0.3) {
    return 'Smooth session — little friction.';
  }
  const denyRate = i.toolCallCount > 0 ? i.permissionDenyCount / i.toolCallCount : 0;
  const errorRate = i.toolCallCount > 0 ? i.toolErrorCount / i.toolCallCount : 0;
  const interruptRate = i.userMessageCount > 0 ? i.interruptCount / i.userMessageCount : 0;
  const shortAbandoned =
    i.status === 'abandoned' && (i.durationSeconds == null || i.durationSeconds < 60);

  // Rank by each signal's weighted contribution (same weights as the formula).
  const drivers = [
    { label: `tool errors (${Math.round(errorRate * 100)}% of calls)`, value: errorRate * 0.3 },
    {
      label: `permission denials (${Math.round(denyRate * 100)}% of calls)`,
      value: denyRate * 0.3,
    },
    {
      label: `interrupts (${Math.round(interruptRate * 100)}% of messages)`,
      value: interruptRate * 0.25,
    },
    { label: 'early abandonment', value: shortAbandoned ? 0.15 : 0 },
  ].sort((a, b) => b.value - a.value);

  const top = drivers[0];
  return top && top.value > 0 ? `Driven mainly by ${top.label}.` : 'Mixed minor friction signals.';
}

/**
 * Friction band + plain-English explanation for a single session. Shows
 * "Insufficient data" (not a misleading 0) when the score is null per
 * DESIGN_DOC §10.6.
 */
export function FrictionBadge({
  inputs,
  score,
}: {
  inputs: FrictionInputsLite;
  score: number | null;
}) {
  if (score === null) {
    return (
      <span className="inline-flex items-center rounded-md bg-white/10 px-2 py-1 text-xs text-white/40">
        Friction: Insufficient data
      </span>
    );
  }

  const b = band(score);
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`inline-flex w-fit items-center rounded-md px-2 py-1 text-xs ${b.color}`}>
        Friction: {b.label} · {score.toFixed(2)}
      </span>
      <span className="text-[10px] text-white/40">
        {explain(score, inputs)} · Friction v{FRICTION_VERSION}
      </span>
    </div>
  );
}
