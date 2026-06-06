import { TopTools } from '@/components/me/TopTools';
import {
  getAnomalies,
  getCostByModel,
  getCostByRepo,
  getCostByTeam,
  getOrgSummary,
  getOrgTopTools,
  getWeeklyCostTrend,
} from '@/lib/org-queries';
import { isOrgAdmin, requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
import { OrgSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function OrgDashboardPage() {
  const { orgRole } = await requireOrgViewer();

  const since = daysAgo(30);
  const isAdmin = isOrgAdmin(orgRole);

  const [summary, teamCost, repoCost, modelCost, tools, trend, anomalies] = await Promise.all([
    getOrgSummary(since),
    getCostByTeam(since),
    getCostByRepo(since),
    getCostByModel(since),
    getOrgTopTools(since),
    getWeeklyCostTrend(12),
    getAnomalies(since),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Org</p>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-white/50">Trailing 30 days · aggregate view</p>
      </div>

      <OrgSubNav active="dashboard" />

      {/* Anomaly banners */}
      {anomalies.length > 0 && (
        <div className="space-y-2">
          {anomalies.map((a) => (
            <div
              key={a.kind}
              className={`rounded-lg border px-4 py-3 text-sm ${
                a.severity === 'critical'
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300'
              }`}
            >
              <span className="font-semibold">{a.label}:</span> {a.message}
            </div>
          ))}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Total cost (30d)" value={`$${summary.totalCostUsd.toFixed(2)}`} />
        <StatCard label="Sessions" value={summary.sessionCount.toString()} />
        <StatCard label="Active users" value={summary.activeUsers.toString()} />
        <StatCard label="Teams" value={summary.teamCount.toString()} />
      </div>

      {/* Weekly cost trend */}
      {trend.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-semibold text-white/70 mb-4">Weekly cost trend</h2>
          <WeeklyTrendBars trend={trend} />
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Cost by team */}
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">Cost by team (top 10)</h2>
          {teamCost.length === 0 ? (
            <p className="text-sm text-white/40">No team data available.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-white/40 text-left">
                  <th className="pb-2 font-medium">Team</th>
                  <th className="pb-2 font-medium text-right">Users</th>
                  <th className="pb-2 font-medium text-right">Sessions</th>
                  <th className="pb-2 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {teamCost.slice(0, 10).map((t) => (
                  <tr key={t.teamSlug}>
                    <td className="py-2">
                      {isAdmin ? (
                        <a href={`/team/${t.teamSlug}`} className="text-brand-400 hover:underline">
                          {t.teamName}
                        </a>
                      ) : (
                        t.teamName
                      )}
                    </td>
                    <td className="py-2 text-right text-white/60">{t.userCount}</td>
                    <td className="py-2 text-right text-white/60">{t.sessionCount}</td>
                    <td className="py-2 text-right font-mono">${t.costUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Cost by repo */}
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">Cost by repo (top 10)</h2>
          {repoCost.length === 0 ? (
            <p className="text-sm text-white/40">No repo data available.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-white/40 text-left">
                  <th className="pb-2 font-medium">Repo</th>
                  <th className="pb-2 font-medium text-right">Sessions</th>
                  <th className="pb-2 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {repoCost.slice(0, 10).map((r) => (
                  <tr key={`${r.repoOwner}/${r.repoName}`}>
                    <td className="py-2 font-mono text-xs">
                      {r.repoOwner}/{r.repoName}
                    </td>
                    <td className="py-2 text-right text-white/60">{r.sessionCount}</td>
                    <td className="py-2 text-right font-mono">${r.costUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Model mix */}
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">Cost by model</h2>
          {modelCost.length === 0 ? (
            <p className="text-sm text-white/40">No model data available.</p>
          ) : (
            <div className="space-y-2">
              {modelCost.map((m) => {
                const total = modelCost.reduce((s, r) => s + r.costUsd, 0);
                const pct = total > 0 ? (m.costUsd / total) * 100 : 0;
                return (
                  <div key={m.model} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-mono text-xs text-white/80">{m.model}</span>
                      <span className="text-white/60">${m.costUsd.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${pct.toFixed(1)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Top tools */}
        <TopTools title="Top Tools (org-wide)" tools={tools} />
      </div>

      {!isAdmin && (
        <p className="text-xs text-white/30 text-center pt-4">
          You are viewing aggregate data only. Individual sessions are not accessible with your
          role.
        </p>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-1">
      <p className="text-xs text-white/50">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

function WeeklyTrendBars({ trend }: { trend: { costUsd: number; day: Date }[] }) {
  const max = Math.max(...trend.map((t) => t.costUsd), 0.01);
  return (
    <div className="flex items-end gap-1 h-24">
      {trend.map((t) => {
        const height = Math.max(4, (t.costUsd / max) * 96);
        const label = new Date(t.day).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
        });
        return (
          <div key={t.day.toISOString()} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[10px] text-white/40">${t.costUsd.toFixed(0)}</span>
            <div
              className="w-full rounded-t bg-brand-500/70 min-h-1"
              style={{ height: `${height}px` }}
              title={`${label}: $${t.costUsd.toFixed(2)}`}
            />
            <span className="text-[9px] text-white/30">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
