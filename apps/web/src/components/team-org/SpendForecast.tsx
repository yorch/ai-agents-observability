import { fmtUsd } from '@/lib/fmt';

// Forward-looking spend projection (Tier 2). Presentational: the page computes the
// raw sums + calendar math and passes the derived numbers in. Two independent
// projections are shown so neither is mistaken for a guarantee — a trailing-7d run
// rate (reacts fast) and a month-to-date pace (smooths weekend dips). When an admin
// has configured a budget_threshold rule, the run-rate is measured against it using
// the same 0.8 warn / 1.0 critical ratios as the alert engine.

const BUDGET_WARN_RATIO = 0.8;
const BUDGET_CRITICAL_RATIO = 1.0;

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
  const budgetAccent =
    budgetRatio >= BUDGET_CRITICAL_RATIO
      ? 'text-red-400'
      : budgetRatio >= BUDGET_WARN_RATIO
        ? 'text-yellow-300'
        : 'text-emerald-400';
  const budgetBar =
    budgetRatio >= BUDGET_CRITICAL_RATIO
      ? 'bg-red-400'
      : budgetRatio >= BUDGET_WARN_RATIO
        ? 'bg-yellow-400'
        : 'bg-emerald-400';

  return (
    <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white/70">Spend forecast</h2>
        <p className="mt-0.5 text-xs text-white/40">
          Run-rate projection from recent spend — a planning estimate, not a guarantee.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <ForecastTile
          label="Projected 30-day spend"
          value={fmtUsd(projected30d)}
          sub="at the trailing-7d run rate"
        />
        <ForecastTile
          label="This month (projected)"
          value={fmtUsd(monthProjection)}
          sub="month-to-date pace"
        />
        <ForecastTile
          label="Daily run rate"
          value={fmtUsd(dailyRunRate)}
          sub="avg / day, last 7d"
        />
      </div>

      {budget && (
        <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-white/60">
              Projected vs budget ({budget.windowDays}-day window)
            </span>
            <span className={`font-mono font-semibold ${budgetAccent}`}>
              {fmtUsd(budget.projectedSpend)} / {fmtUsd(budget.budgetUsd)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className={`h-full rounded-full ${budgetBar}`}
              style={{ width: `${Math.min(100, budgetRatio * 100)}%` }}
            />
          </div>
          {budgetRatio >= BUDGET_WARN_RATIO && (
            <p className={`text-xs ${budgetAccent}`}>
              {budgetRatio >= BUDGET_CRITICAL_RATIO
                ? 'On track to exceed the configured budget this window.'
                : 'Approaching the configured budget for this window.'}
            </p>
          )}
        </div>
      )}

      {teams.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-widest text-white/40">
            Projected 30-day spend by team
          </p>
          <div className="space-y-1">
            {teams.map((t) => {
              const teamProjected = (t.last7Spend / 7) * 30;
              return (
                <div key={t.teamSlug} className="flex items-center justify-between text-xs">
                  <span className="text-white/70">{t.teamName}</span>
                  <span className="font-mono text-white/60">{fmtUsd(teamProjected)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function ForecastTile({ label, sub, value }: { label: string; sub: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <p className="text-xs text-white/40">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold text-white">{value}</p>
      <p className="text-[11px] text-white/30">{sub}</p>
    </div>
  );
}
