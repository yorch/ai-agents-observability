import { FrictionDistributionChart } from '@/components/me/FrictionDistributionChart';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { TopTools } from '@/components/me/TopTools';
import { AdoptionFunnel } from '@/components/team-org/AdoptionFunnel';
import { CohortFrictionTable } from '@/components/team-org/CohortFrictionTable';
import { CohortFrictionTrendChart } from '@/components/team-org/CohortFrictionTrendChart';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { ModelGovernanceTable } from '@/components/team-org/ModelGovernanceTable';
import { ProjectionRealization } from '@/components/team-org/ProjectionRealization';
import { SpendForecast } from '@/components/team-org/SpendForecast';
import { axisMoney, BarChart, Card, CardEmpty, Cell, Row, Stat, Table } from '@/components/ui';
import { getOrgCohortFriction } from '@/lib/cohort-queries';
import { fmtDayShort } from '@/lib/fmt';
import {
  getActiveBudget,
  getAnomalies,
  getCostByModel,
  getCostByRepo,
  getCostByTeam,
  getOrgAdoptionFunnel,
  getOrgEffectiveness,
  getOrgFrictionTrend,
  getOrgSummaryWithDelta,
  getOrgTopTools,
  getSpendForecast,
  getTeamModelGovernance,
  getTeamSpendForecast,
  getWeeklyCostTrend,
} from '@/lib/org-queries';
import { getGuardMetrics, getSpendActuals } from '@/lib/projection-queries';
import type { ProjectionInput, RegisteredProjection } from '@/lib/projections';
import {
  listClosedProjections,
  rangeFrom,
  realizeProjection,
  recordProjections,
  startOfUtcDay,
} from '@/lib/projections';
import { isOrgAdmin, requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

/** Spells a range into the two required projection fields. */
function rangeToProjected(r: { high: number; low: number }): {
  projectedHigh: number;
  projectedLow: number;
} {
  return { projectedHigh: r.high, projectedLow: r.low };
}

export default async function OrgDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);

  const { orgRole } = await requireOrgViewer();
  const isAdmin = isOrgAdmin(orgRole);

  // Calendar boundaries for the spend forecast: month-to-date pace and the
  // trailing-7d run rate. Kept out of the query so the "days elapsed" math is
  // visible and testable here rather than buried in SQL.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const last7Start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  const [
    summaryWithDelta,
    teamCost,
    repoCost,
    modelCost,
    tools,
    trend,
    anomalies,
    effectiveness,
    frictionTrend,
    funnel,
    modelGov,
    forecast,
    teamForecast,
    budget,
    cohortFriction,
  ] = await Promise.all([
    getOrgSummaryWithDelta(range),
    getCostByTeam(since),
    getCostByRepo(since),
    getCostByModel(since),
    getOrgTopTools(since),
    getWeeklyCostTrend(12),
    getAnomalies(),
    getOrgEffectiveness(since),
    getOrgFrictionTrend(since),
    getOrgAdoptionFunnel(range),
    isAdmin ? getTeamModelGovernance(since) : Promise.resolve([]),
    getSpendForecast(monthStart, last7Start),
    getTeamSpendForecast(last7Start),
    getActiveBudget(),
    getOrgCohortFriction(since),
  ]);

  const { current: summary, deltas } = summaryWithDelta;

  const modelTotalCost = modelCost.reduce((s, r) => s + r.costUsd, 0);

  // Forecast projections (Tier 2). Two independent estimators of the same
  // quantity — a trailing-7d run rate (reacts fast) and a month-to-date pace
  // (smooths weekend dips) — and P13-006 turns their spread into the projected
  // range rather than picking one and printing it as a fact. Where they agree,
  // `rangeFrom` still widens to a minimum band: a run-rate extrapolation is not
  // precise just because two estimators of it happen to coincide.
  const dailyRunRate = forecast.last7Spend / 7;
  const mtdDailyRate = dayOfMonth > 0 ? forecast.mtdSpend / dayOfMonth : 0;
  const daysLeftInMonth = Math.max(0, daysInMonth - dayOfMonth);
  const monthRange = rangeFrom([
    forecast.mtdSpend + mtdDailyRate * daysLeftInMonth,
    forecast.mtdSpend + dailyRunRate * daysLeftInMonth,
  ]);
  const rolling30dRange = rangeFrom([dailyRunRate * 30, mtdDailyRate * 30]);

  // Registration is what makes these claims checkable later; `SpendForecast`
  // renders from the registered objects, so a forecast that reaches the screen is
  // on the record by construction.
  // Claim periods are UTC so the unique key is stable regardless of where the
  // server thinks it is; the display maths above stays on the existing local
  // calendar so no dashboard number moves.
  const monthStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const claimStart = startOfUtcDay(now);
  const guardBaseline = await getGuardMetrics(daysAgo(range), now);

  const claimInputs: ProjectionInput[] = [
    {
      baselineValue: forecast.mtdSpend,
      baselineWindowDays: dayOfMonth,
      claimType: 'monthly_spend',
      guardBaseline,
      periodEnd: monthEnd,
      periodStart: monthStartUtc,
      projectedHigh: monthRange.high,
      projectedLow: monthRange.low,
      segment: 'org',
    },
    {
      baselineValue: forecast.last7Spend,
      baselineWindowDays: 7,
      claimType: 'rolling_30d_spend',
      guardBaseline,
      periodEnd: new Date(claimStart.getTime() + 30 * 86_400_000),
      periodStart: claimStart,
      projectedHigh: rolling30dRange.high,
      projectedLow: rolling30dRange.low,
      segment: 'org',
    },
    ...(budget
      ? [
          {
            baselineValue: forecast.last7Spend,
            baselineWindowDays: 7,
            claimType: 'budget_window_spend' as const,
            guardBaseline,
            metadata: { budgetUsd: budget.budgetUsd, windowDays: budget.windowDays },
            periodEnd: new Date(claimStart.getTime() + budget.windowDays * 86_400_000),
            periodStart: claimStart,
            ...rangeToProjected(rangeFrom([dailyRunRate * budget.windowDays])),
            segment: 'org',
          },
        ]
      : []),
    // Per-team forecasts are claims too. One estimator each (trailing 7d), so
    // their range is the minimum band — narrower would overstate what a single
    // week of one team's spend can support.
    ...teamForecast.map((t) => ({
      baselineValue: t.last7Spend,
      baselineWindowDays: 7,
      claimType: 'rolling_30d_spend' as const,
      guardBaseline,
      periodEnd: new Date(claimStart.getTime() + 30 * 86_400_000),
      periodStart: claimStart,
      ...rangeToProjected(rangeFrom([(t.last7Spend / 7) * 30])),
      segment: `team:${t.teamSlug}`,
    })),
  ];

  const registered = await recordProjections(claimInputs);
  const bySegment = (claimType: string, segment: string): RegisteredProjection | undefined =>
    registered.find((p) => p.claimType === claimType && p.segment === segment);

  const monthClaim = bySegment('monthly_spend', 'org');
  const rolling30dClaim = bySegment('rolling_30d_spend', 'org');
  const budgetProjection = budget ? bySegment('budget_window_spend', 'org') : undefined;
  const teamClaims = teamForecast.flatMap((t) => {
    const projection = bySegment('rolling_30d_spend', `team:${t.teamSlug}`);
    return projection ? [{ projection, teamName: t.teamName, teamSlug: t.teamSlug }] : [];
  });

  // Projected-vs-actual for months that have already closed. Pure comparison;
  // "not yet measurable" until a closed month has enough sessions behind it.
  const closedMonths = await listClosedProjections('monthly_spend', now, 6);
  const monthRealizations = await Promise.all(
    closedMonths.map(async (p) =>
      realizeProjection(p, await getSpendActuals(p.periodStart, p.periodEnd), now),
    ),
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-xs text-text-3 uppercase tracking-wider mb-1">Org</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-text-2">Trailing {range} days · aggregate view</p>
        </div>
        <DateRangePicker range={range} />
      </div>

      {/* Anomaly banners */}
      {anomalies.length > 0 && (
        <div className="space-y-2">
          {anomalies.map((a) => (
            <div
              key={a.label}
              className={`rounded-lg border px-4 py-3 text-sm ${
                a.severity === 'critical'
                  ? 'border-crit-line bg-crit-soft text-crit'
                  : 'border-warn-line bg-warn-soft text-warn'
              }`}
            >
              <span className="font-semibold">{a.label}:</span> {a.message}
            </div>
          ))}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat
          label={`Total cost (${range}d)`}
          value={`$${summary.totalCostUsd.toFixed(2)}`}
          delta={deltas.totalCostUsd}
        />
        <Stat
          label="Sessions"
          value={summary.sessionCount.toString()}
          delta={deltas.sessionCount}
        />
        <Stat
          label="Active users"
          value={summary.activeUsers.toString()}
          delta={deltas.activeUsers}
        />
        <Stat label="Teams" value={summary.teamCount.toString()} />
        <Stat
          label="Cache hit rate"
          value={`${summary.cacheHitRate.toFixed(1)}%`}
          delta={deltas.cacheHitRate}
        />
      </div>

      {/* Weekly cost trend */}
      {trend.length > 0 && (
        <Card title="Weekly cost trend" caption="Twelve weeks" hint="hover for detail">
          <BarChart
            data={trend.map((t) => ({
              label: fmtDayShort(new Date(t.day)),
              values: [t.costUsd],
            }))}
            format={axisMoney}
            series={['Spend']}
          />
        </Card>
      )}

      {/* Spend forecast — every forward-looking number here is a registered
          projection (P13-006), so the card cannot show a claim that was not
          recorded. */}
      {monthClaim && rolling30dClaim && (
        <SpendForecast
          budgetClaim={
            budget && budgetProjection
              ? {
                  budgetUsd: budget.budgetUsd,
                  projection: budgetProjection,
                  windowDays: budget.windowDays,
                }
              : null
          }
          dailyRunRate={dailyRunRate}
          monthClaim={monthClaim}
          rolling30dClaim={rolling30dClaim}
          teamClaims={teamClaims}
        />
      )}

      {/* …and how the closed months actually came out. */}
      <ProjectionRealization
        caption="Each month's spend projection is recorded when it is shown, then compared against what the month actually cost. Months with too few sessions behind them read as not yet measurable rather than as a delta."
        realizations={monthRealizations}
        title="Spend forecast vs actual"
      />

      {/* Adoption funnel */}
      <AdoptionFunnel funnel={funnel} />

      <div className="grid gap-6 md:grid-cols-2">
        {/* Cost by team */}
        <Card title="Cost by team (top 10)" contentClassName="space-y-3">
          {teamCost.length === 0 ? (
            <CardEmpty>No team activity in this period.</CardEmpty>
          ) : (
            <Table
              columns={[
                { label: 'Team' },
                { align: 'right', label: 'Users' },
                { align: 'right', label: 'Sessions' },
                { align: 'right', label: 'Cost' },
              ]}
            >
              {teamCost.slice(0, 10).map((t) => (
                <Row key={t.teamSlug}>
                  <Cell>
                    {isAdmin ? (
                      <a href={`/team/${t.teamSlug}`} className="text-accent hover:underline">
                        {t.teamName}
                      </a>
                    ) : (
                      t.teamName
                    )}
                  </Cell>
                  <Cell num className="text-text-2">
                    {t.userCount}
                  </Cell>
                  <Cell num className="text-text-2">
                    {t.sessionCount}
                  </Cell>
                  <Cell num>${t.costUsd.toFixed(2)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        {/* Cost by repo */}
        <Card title="Cost by repo (top 10)" contentClassName="space-y-3">
          {repoCost.length === 0 ? (
            <CardEmpty>No repo activity in this period.</CardEmpty>
          ) : (
            <Table
              columns={[
                { label: 'Repo' },
                { align: 'right', label: 'Sessions' },
                { align: 'right', label: 'Cost' },
              ]}
            >
              {repoCost.slice(0, 10).map((r) => (
                <Row key={`${r.repoOwner}/${r.repoName}`}>
                  <Cell className="text-xs">
                    {r.repoOwner}/{r.repoName}
                  </Cell>
                  <Cell num className="text-text-2">
                    {r.sessionCount}
                  </Cell>
                  <Cell num>${r.costUsd.toFixed(2)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Model mix */}
        <Card title="Cost by model" contentClassName="space-y-3">
          {modelCost.length === 0 ? (
            <CardEmpty>No model usage in this period.</CardEmpty>
          ) : (
            <div className="space-y-2">
              {modelCost.map((m) => {
                const pct = modelTotalCost > 0 ? (m.costUsd / modelTotalCost) * 100 : 0;
                return (
                  <div key={m.model} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-mono text-xs text-text">{m.model}</span>
                      <span className="text-text-2">${m.costUsd.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${pct.toFixed(1)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Top tools */}
        <TopTools title="Top Tools (org-wide)" tools={tools} />
      </div>

      {/* Per-team model governance (admin-only) */}
      {isAdmin && <ModelGovernanceTable rows={modelGov} />}

      {/* Effectiveness — aggregate only, visibility-scoped */}
      <div className="grid gap-6 md:grid-cols-2">
        <FrictionDistributionChart
          distribution={effectiveness}
          title="Friction distribution (org)"
        />
        <ShapeDistributionChart histogram={effectiveness.shapeMix} />
      </div>

      <CohortFrictionTrendChart points={frictionTrend} title="Org friction trend (weekly)" />

      <CohortFrictionTable rows={cohortFriction} />

      {!isAdmin && (
        <p className="text-xs text-text-3 text-center pt-4">
          You are viewing aggregate data only. Individual sessions are not accessible with your
          role.
        </p>
      )}
    </div>
  );
}
