import { ArrowDownIcon, ArrowUpIcon } from '@/components/icons';
import type { UsageSummary } from '@/lib/me-queries';

function DeltaBadge({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) {
    return null;
  }
  if (previous === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-400 font-mono">
        <ArrowUpIcon size={12} /> new
      </span>
    );
  }

  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) {
    return null;
  }

  const up = pct > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-mono ${up ? 'text-green-400' : 'text-red-400'}`}
    >
      {up ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />} {Math.abs(pct).toFixed(0)}%
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
    <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
      <p className="text-xs text-text-3 uppercase tracking-widest">{label}</p>
      <p className="text-2xl font-mono font-semibold text-text">{format(thisWeek)}</p>
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
        label="Cost"
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
