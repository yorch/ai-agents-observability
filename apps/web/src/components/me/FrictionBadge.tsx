import { Badge } from '@/components/ui';
import { FRICTION_VERSION, frictionBadge } from '@/lib/effectiveness';

export type FrictionInputsLite = {
  durationSeconds: number | null;
  interruptCount: number;
  permissionDenyCount: number;
  status: string;
  toolCallCount: number;
  toolErrorCount: number;
  userMessageCount: number;
};

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

  const b = frictionBadge(score);
  return (
    <div className="flex flex-col gap-0.5">
      {/* A native disclosure, so the formula is reachable by keyboard and
          screen readers, not only on hover — this is the one place the metric
          is explained. Hover still previews it for pointer users. */}
      <details className="group relative w-fit">
        <summary className="cursor-default list-none [&::-webkit-details-marker]:hidden">
          <Badge tone={b.tone} dot={false}>
            Friction: {b.label} · {score.toFixed(2)}
            <span className="opacity-50">?</span>
          </Badge>
        </summary>
        <div className="pointer-events-none absolute left-0 top-full mt-1.5 z-50 hidden w-64 rounded-lg border border-border bg-surface p-3 shadow-lg group-hover:block group-open:block">
          <p className="text-xs font-semibold text-text mb-2">How friction is calculated</p>
          <p className="text-[11px] text-text-3 mb-2">
            Composite score [0–1] from four signals. Higher = more friction.
          </p>
          <div className="space-y-1">
            {[
              { label: 'Tool error rate', weight: '30%' },
              { label: 'Permission deny rate', weight: '30%' },
              { label: 'Interrupt rate', weight: '25%' },
              { label: 'Early abandonment', weight: '15%' },
            ].map((r) => (
              <div key={r.label} className="flex justify-between text-[11px]">
                <span className="text-text-2">{r.label}</span>
                <span className="text-text-3 font-mono">{r.weight}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 pt-2 border-t border-border text-[10px] text-text-3">
            Low &lt; 0.3 · Medium 0.3–0.6 · High &gt; 0.6 · v{FRICTION_VERSION}
          </div>
        </div>
      </details>
      <span className="text-[10px] text-text-3">{explain(score, inputs)}</span>
    </div>
  );
}
