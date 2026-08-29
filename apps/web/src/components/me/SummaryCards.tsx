'use client';

import { Stat } from '@/components/ui';
import { useDict } from '@/i18n/provider';
import type { UsageSummary } from '@/lib/me-queries';

/** Fractional change, guarding the divide-by-zero when the prior period is empty. */
function delta(current: number, previous: number): number | null {
  return previous === 0 ? null : (current - previous) / previous;
}

export function SummaryCards({
  thisWeek,
  lastWeek,
}: {
  thisWeek: UsageSummary;
  lastWeek: UsageSummary;
}) {
  const dict = useDict();
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Stat
        label={dict.me.summary.sessions}
        value={thisWeek.sessionCount.toString()}
        delta={delta(thisWeek.sessionCount, lastWeek.sessionCount)}
      />
      <Stat
        label={dict.me.summary.cost}
        value={`$${thisWeek.totalCostUsd.toFixed(2)}`}
        delta={delta(thisWeek.totalCostUsd, lastWeek.totalCostUsd)}
        deltaInverted
      />
      <Stat
        label={dict.me.summary.hours}
        value={thisWeek.totalHours.toFixed(1)}
        delta={delta(thisWeek.totalHours, lastWeek.totalHours)}
      />
      <Stat
        label={dict.me.summary.repos}
        value={thisWeek.repoCount.toString()}
        delta={delta(thisWeek.repoCount, lastWeek.repoCount)}
      />
    </div>
  );
}
