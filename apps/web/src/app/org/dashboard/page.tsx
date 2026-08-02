import { FrictionDistributionChart } from '@/components/me/FrictionDistributionChart';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { TopTools } from '@/components/me/TopTools';
import { AdoptionFunnel } from '@/components/team-org/AdoptionFunnel';
import { CohortFrictionTable } from '@/components/team-org/CohortFrictionTable';
import { CohortFrictionTrendChart } from '@/components/team-org/CohortFrictionTrendChart';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { ModelGovernanceTable } from '@/components/team-org/ModelGovernanceTable';
import { SpendForecast } from '@/components/team-org/SpendForecast';
import { axisMoney, BarChart, Card, Cell, Row, Stat, Table } from '@/components/ui';
import { getOrgCohortFriction } from '@/lib/cohort-queries';
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
import { isOrgAdmin, requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

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

  // Forecast projections (Tier 2). Trailing-7d run rate drives the 30-day and
  // budget-window projections; month-to-date pace drives the calendar-month one.
  const dailyRunRate = forecast.last7Spend / 7;
  const projected30d = dailyRunRate * 30;
  const monthProjection = dayOfMonth > 0 ? (forecast.mtdSpend / dayOfMonth) * daysInMonth : 0;
  const forecastBudget = budget
    ? {
        budgetUsd: budget.budgetUsd,
        projectedSpend: dailyRunRate * budget.windowDays,
        windowDays: budget.windowDays,
      }
    : null;

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
              key={a.kind}
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
              label: new Date(t.day).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
              }),
              values: [t.costUsd],
            }))}
            format={axisMoney}
            series={['Spend']}
          />
        </Card>
      )}

      {/* Spend forecast */}
      <SpendForecast
        budget={forecastBudget}
        dailyRunRate={dailyRunRate}
        monthProjection={monthProjection}
        projected30d={projected30d}
        teams={teamForecast}
      />

      {/* Adoption funnel */}
      <AdoptionFunnel funnel={funnel} />

      <div className="grid gap-6 md:grid-cols-2">
        {/* Cost by team */}
        <Card title="Cost by team (top 10)" contentClassName="space-y-3">
          {teamCost.length === 0 ? (
            <p className="text-sm text-text-3">No team data available.</p>
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
            <p className="text-sm text-text-3">No repo data available.</p>
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
            <p className="text-sm text-text-3">No model data available.</p>
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
