import { Card, Stat } from '@/components/ui';
import { fmtUsd } from '@/lib/fmt';

// Forward-looking spend projection (Tier 2). Presentational: the page computes the
// raw sums + calendar math and passes the derived numbers in. Two independent
// projections are shown so neither is mistaken for a guarantee — a trailing-7d run
// rate (reacts fast) and a month-to-date pace (smooths weekend dips). When an admin
// has configured a budget_threshold rule, the run-rate is measured against it using
// the same 0.8 warn / 1.0 critical ratios as the alert engine.

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

export type SpendForecastProps = {
  budget: { budgetUsd: number; projectedSpend: number; windowDays: number } | null;
  dailyRunRate: number;
  monthProjection: number;
  projected30d: number;
  teams: { last7Spend: number; teamName: string; teamSlug: string }[];
};

export function SpendForecast({
  budget,
  dailyRunRate,
  monthProjection,
  projected30d,
  teams,
}: SpendForecastProps) {
  const budgetRatio = budget && budget.budgetUsd > 0 ? budget.projectedSpend / budget.budgetUsd : 0;
  const level = BUDGET_LEVEL[budgetLevel(budgetRatio)];

  return (
    <Card
      title="Spend forecast"
      caption="Run-rate projection from recent spend — a planning estimate, not a guarantee."
      contentClassName="space-y-4"
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          label="Projected 30-day spend"
          value={fmtUsd(projected30d)}
          sub="at the trailing-7d run rate"
        />
        <Stat
          label="This month (projected)"
          value={fmtUsd(monthProjection)}
          sub="month-to-date pace"
        />
        <Stat label="Daily run rate" value={fmtUsd(dailyRunRate)} sub="avg / day, last 7d" />
      </div>

      {budget && (
        <div className="space-y-1.5 rounded-lg border border-border bg-surface p-3">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-text-2">
              Projected vs budget ({budget.windowDays}-day window)
            </span>
            <span className={`font-mono font-semibold ${level.text}`}>
              {fmtUsd(budget.projectedSpend)} / {fmtUsd(budget.budgetUsd)}
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

      {teams.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-widest text-text-3">
            Projected 30-day spend by team
          </p>
          <div className="space-y-1">
            {teams.map((t) => {
              const teamProjected = (t.last7Spend / 7) * 30;
              return (
                <div key={t.teamSlug} className="flex items-center justify-between text-xs">
                  <span className="text-text-2">{t.teamName}</span>
                  <span className="font-mono text-text-2">{fmtUsd(teamProjected)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
