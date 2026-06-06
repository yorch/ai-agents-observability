import type { UsageSummary } from '@/lib/me-queries';

function DeltaBadge({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) {
    return null;
  }
  if (previous === 0) {
    return <span className="text-xs text-green-400">↑ new</span>;
  }

  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) {
    return null;
  }

  const up = pct > 0;
  return (
    <span className={`text-xs ${up ? 'text-green-400' : 'text-red-400'}`}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

type CardProps = {
  label: string;
  thisWeek: number;
  lastWeek: number;
  format: (v: number) => string;
};

function Card({ label, thisWeek, lastWeek, format }: CardProps) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-1">
      <p className="text-xs text-white/50">{label}</p>
      <p className="text-2xl font-semibold">{format(thisWeek)}</p>
      <DeltaBadge current={thisWeek} previous={lastWeek} />
    </div>
  );
}

export function SummaryCards({
  thisWeek,
  lastWeek,
}: {
  thisWeek: UsageSummary;
  lastWeek: UsageSummary;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Card
        label="Sessions"
        thisWeek={thisWeek.sessionCount}
        lastWeek={lastWeek.sessionCount}
        format={(v) => v.toString()}
      />
      <Card
        label="Cost (USD)"
        thisWeek={thisWeek.totalCostUsd}
        lastWeek={lastWeek.totalCostUsd}
        format={(v) => `$${v.toFixed(2)}`}
      />
      <Card
        label="Hours"
        thisWeek={thisWeek.totalHours}
        lastWeek={lastWeek.totalHours}
        format={(v) => v.toFixed(1)}
      />
      <Card
        label="Repos"
        thisWeek={thisWeek.repoCount}
        lastWeek={lastWeek.repoCount}
        format={(v) => v.toString()}
      />
    </div>
  );
}
