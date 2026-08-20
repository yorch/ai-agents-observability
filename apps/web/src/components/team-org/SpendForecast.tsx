import { Card, Stat } from '@/components/ui';
import { fmtUsd } from '@/lib/fmt';
import type { RegisteredProjection } from '@/lib/projections';

/**
 * Forward-looking spend projection (Tier 2). Presentational: the page computes
 * the raw sums + calendar math, registers each claim, and passes the registered
 * projections in.
 *
 * P13-006: every forward-looking number here arrives as a `RegisteredProjection`
 * — a type only `recordProjection(s)` can produce — so this card cannot render a
 * prediction that was not written to the projection registry first. The
 * trailing-7d **run rate** is the one bare number left, and deliberately: it is a
 * measurement of what already happened, not a claim about what will.
 *
 * Ranges rather than point estimates throughout, for the same reason they are
 * stored that way: a run-rate extrapolation printed to the cent reads as far more
 * certainty than it has.
 *
 * When an admin has configured a budget_threshold rule, the projection is
 * measured against it using the same 0.8 warn / 1.0 critical ratios as the alert
 * engine — against the **top** of the range, so the warning fires on the case the
 * reader would rather know about.
 */

const BUDGET_WARN_RATIO = 0.8;
const BUDGET_CRITICAL_RATIO = 1.0;

// One classification of the projected/budget ratio → the text + bar colors and
// the callout copy, so the three can't drift apart.
const BUDGET_LEVEL = {
  critical: {
    bar: 'bg-crit',
    copy: 'On track to exceed the configured budget this window.',
    text: 'text-crit',
  },
  ok: { bar: 'bg-good', copy: '', text: 'text-good' },
  warn: {
    bar: 'bg-warn',
    copy: 'Approaching the configured budget for this window.',
    text: 'text-warn',
  },
} as const;

function budgetLevel(ratio: number): keyof typeof BUDGET_LEVEL {
  if (ratio >= BUDGET_CRITICAL_RATIO) {
    return 'critical';
  }
  return ratio >= BUDGET_WARN_RATIO ? 'warn' : 'ok';
}

function fmtRange(p: RegisteredProjection): string {
  return `${fmtUsd(p.projectedLow)} – ${fmtUsd(p.projectedHigh)}`;
}

export type SpendForecastProps = {
  budgetClaim: {
    budgetUsd: number;
    projection: RegisteredProjection;
    windowDays: number;
  } | null;
  dailyRunRate: number;
  monthClaim: RegisteredProjection;
  rolling30dClaim: RegisteredProjection;
  teamClaims: { projection: RegisteredProjection; teamName: string; teamSlug: string }[];
};

export function SpendForecast({
  budgetClaim,
  dailyRunRate,
  monthClaim,
  rolling30dClaim,
  teamClaims,
}: SpendForecastProps) {
  const budgetRatio =
    budgetClaim && budgetClaim.budgetUsd > 0
      ? budgetClaim.projection.projectedHigh / budgetClaim.budgetUsd
      : 0;
  const level = BUDGET_LEVEL[budgetLevel(budgetRatio)];

  return (
    <Card
      title="Spend forecast"
      caption="Run-rate projection from recent spend — a planning estimate, not a guarantee. Each projection is recorded when it is shown and checked once its period closes."
      contentClassName="space-y-4"
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          label="Projected 30-day spend"
          value={fmtRange(rolling30dClaim)}
          sub="trailing run rate vs month-to-date pace"
        />
        <Stat label="This month (projected)" value={fmtRange(monthClaim)} sub="to month end" />
        <Stat label="Daily run rate" value={fmtUsd(dailyRunRate)} sub="avg / day, last 7d" />
      </div>

      {budgetClaim && (
        <div className="space-y-1.5 rounded-lg border border-border bg-surface p-3">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-text-2">
              Projected vs budget ({budgetClaim.windowDays}-day window)
            </span>
            <span className={`font-mono font-semibold ${level.text}`}>
              {fmtRange(budgetClaim.projection)} / {fmtUsd(budgetClaim.budgetUsd)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className={`h-full rounded-full ${level.bar}`}
              style={{ width: `${Math.min(100, budgetRatio * 100)}%` }}
            />
          </div>
          {level.copy && <p className={`text-xs ${level.text}`}>{level.copy}</p>}
        </div>
      )}

      {teamClaims.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-widest text-text-3">
            Projected 30-day spend by team
          </p>
          <div className="space-y-1">
            {teamClaims.map((t) => (
              <div key={t.teamSlug} className="flex items-center justify-between text-xs">
                <span className="text-text-2">{t.teamName}</span>
                <span className="font-mono text-text-2">{fmtRange(t.projection)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
