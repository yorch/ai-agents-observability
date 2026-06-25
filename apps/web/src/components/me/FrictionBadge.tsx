import { FRICTION_VERSION } from '@/lib/effectiveness';

export type FrictionInputsLite = {
  durationSeconds: number | null;
  interruptCount: number;
  permissionDenyCount: number;
  status: string;
  toolCallCount: number;
  toolErrorCount: number;
  userMessageCount: number;
};

function band(score: number): { color: string; label: string } {
  if (score < 0.3) {
    return { color: 'bg-green-500/15 text-green-400', label: 'Low' };
  }
  if (score <= 0.6) {
    return { color: 'bg-yellow-500/15 text-yellow-400', label: 'Medium' };
  }
  return { color: 'bg-red-500/15 text-red-400', label: 'High' };
}

function explain(score: number, i: FrictionInputsLite): string {
  if (score < 0.3) {
    return 'Smooth session — little friction.';
  }
  const denyRate = i.toolCallCount > 0 ? i.permissionDenyCount / i.toolCallCount : 0;
  const errorRate = i.toolCallCount > 0 ? i.toolErrorCount / i.toolCallCount : 0;
  const interruptRate = i.userMessageCount > 0 ? i.interruptCount / i.userMessageCount : 0;
  const shortAbandoned =
    i.status === 'ABANDONED' && (i.durationSeconds == null || i.durationSeconds < 60);

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

export function FrictionBadge({
  inputs,
  score,
}: {
  inputs: FrictionInputsLite;
  score: number | null;
}) {
  if (score === null) {
    return (
      <span className="inline-flex items-center rounded bg-surface-2 px-2 py-1 text-xs text-text-3">
        Friction: Insufficient data
      </span>
    );
  }

  const b = band(score);
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`inline-flex w-fit items-center rounded px-2 py-1 text-xs font-mono ${b.color}`}
      >
        Friction: {b.label} · {score.toFixed(2)}
      </span>
      <span className="text-[10px] text-text-3">
        {explain(score, inputs)} · Friction v{FRICTION_VERSION}
      </span>
    </div>
  );
}
