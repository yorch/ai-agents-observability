import { Card, TONE_BG, TONE_TEXT } from '@/components/ui';
import type { CohortFrictionRow } from '@/lib/cohort-queries';
import { frictionBadge } from '@/lib/effectiveness';

// Small-n suppression mirrors the effectiveness aggregates elsewhere on
// /org/dashboard: a cohort must have enough distinct devs and enough scored
// sessions before its median is shown, so a single new hire's friction score
// is never individually re-identifiable.
const MIN_COHORT_USERS = 3;
const MIN_COHORT_SCORED_SESSIONS = 5;

// Org cohort friction divergence — median friction per first-seen-month
// cohort, so a lead can see whether newer cohorts ramp to the same
// effectiveness as veterans. Server component (pure render); the query is
// already visibility-scoped to org-metadata sharers.
export function CohortFrictionTable({ rows }: { rows: CohortFrictionRow[] }) {
  const qualifying = rows.filter(
    (r) =>
      r.userCount >= MIN_COHORT_USERS &&
      r.scoredSessions >= MIN_COHORT_SCORED_SESSIONS &&
      r.medianFriction !== null,
  );
  const maxFriction = Math.max(...qualifying.map((r) => r.medianFriction ?? 0), 0.01);

  return (
    <Card className="space-y-3">
      <h2 className="font-display text-sm font-semibold text-text">Cohort friction divergence</h2>
      <p className="text-xs text-text-2">
        Median friction by first-seen-month cohort. Diverging newer cohorts may signal an onboarding
        or enablement gap. Aggregate, ≥3 devs per cohort.
      </p>

      {qualifying.length === 0 ? (
        <p className="text-sm text-text-3">Not enough data per cohort to compare.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-3 text-left">
              <th className="pb-2 font-medium">Cohort</th>
              <th className="pb-2 font-medium text-right">Devs</th>
              <th className="pb-2 font-medium text-right">Median friction</th>
              <th className="pb-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {qualifying.map((r) => {
              // Non-null: filtered above.
              const median = r.medianFriction as number;
              const badge = frictionBadge(median);
              return (
                <tr key={r.cohortMonth}>
                  <td className="py-2 font-mono text-xs">{r.cohortMonth}</td>
                  <td className="py-2 text-right text-text-2">{r.userCount}</td>
                  <td className={`py-2 text-right font-mono ${TONE_TEXT[badge.tone]}`}>
                    {(median * 100).toFixed(0)}%
                  </td>
                  <td className="py-2 pl-3">
                    <div className="h-1.5 rounded-full bg-surface-2">
                      <div
                        className={`h-full rounded-full ${TONE_BG[badge.tone]}`}
                        style={{ width: `${(median / maxFriction) * 100}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
