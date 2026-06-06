import { requireTeamLead } from '../../../lib/roles';
import {
  getTeamModelMix,
  getTeamSummary,
  getTeamTopTools,
  resolveTeamVisibility,
} from '../../../lib/team-queries';
import { TeamSubNav } from './layout';

export const dynamic = 'force-dynamic';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export default async function TeamOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { teamId, teamName } = await requireTeamLead(slug);

  const since = new Date(Date.now() - THIRTY_DAYS_MS);
  const { totalCount, visibleIds } = await resolveTeamVisibility(teamId);

  const [summary, tools, models] = await Promise.all([
    getTeamSummary(since, visibleIds, totalCount),
    getTeamTopTools(since, visibleIds),
    getTeamModelMix(since, visibleIds),
  ]);

  const hasData = summary.sessionCount > 0;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Team</p>
        <h1 className="text-2xl font-semibold">{teamName}</h1>
        <p className="mt-1 text-sm text-white/50">Trailing 30 days</p>
      </div>

      <TeamSubNav slug={slug} active="overview" />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Sessions" value={summary.sessionCount.toString()} />
        <StatCard label="Cost (USD)" value={`$${summary.totalCostUsd.toFixed(2)}`} />
        <StatCard label="Hours" value={summary.totalHours.toFixed(1)} />
        <StatCard label="Active members" value={summary.activeMembers.toString()} />
      </div>

      {!hasData ? (
        <EmptyState />
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <TopToolsCard tools={tools} />
          <ModelMixCard models={models} />
        </div>
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

function TopToolsCard({ tools }: { tools: { callCount: number; toolName: string }[] }) {
  if (tools.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h2 className="text-sm font-medium text-white/70 mb-4">Top Tools</h2>
        <p className="text-sm text-white/40">No data</p>
      </div>
    );
  }
  const max = Math.max(...tools.map((t) => t.callCount), 1);
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h2 className="text-sm font-medium text-white/70 mb-4">Top Tools</h2>
      <div className="space-y-3">
        {tools.map((tool) => (
          <div key={tool.toolName}>
            <div className="flex justify-between text-xs mb-1">
              <span className="truncate text-white/80">{tool.toolName}</span>
              <span className="ml-2 shrink-0 text-white/50">{tool.callCount}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-brand-500"
                style={{ width: `${(tool.callCount / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelMixCard({ models }: { models: { costUsd: number; model: string; turns: number }[] }) {
  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h2 className="text-sm font-medium text-white/70 mb-4">Model Usage</h2>
        <p className="text-sm text-white/40">No data</p>
      </div>
    );
  }
  const totalTurns = models.reduce((sum, m) => sum + m.turns, 0) || 1;
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h2 className="text-sm font-medium text-white/70 mb-4">Model Usage</h2>
      <div className="flex h-3 w-full overflow-hidden rounded-full mb-4">
        {models.map((m, i) => {
          const colors = ['bg-brand-500', 'bg-brand-600', 'bg-brand-700'];
          return (
            <div
              key={m.model}
              className={colors[i % colors.length]}
              style={{ width: `${(m.turns / totalTurns) * 100}%` }}
              title={`${m.model}: ${m.turns} turns`}
            />
          );
        })}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/10 text-white/40">
            <th className="pb-2 text-left">Model</th>
            <th className="pb-2 text-right">Turns</th>
            <th className="pb-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model} className="border-b border-white/5">
              <td className="max-w-[120px] truncate py-1.5 text-white/80">{m.model}</td>
              <td className="py-1.5 text-right text-white/60">{m.turns}</td>
              <td className="py-1.5 text-right text-white/60">${m.costUsd.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-white/10 p-8 text-center">
      <p className="text-lg font-medium">No activity yet</p>
      <p className="mt-2 text-sm text-white/50">
        Sessions will appear here once team members install the hook and run Claude Code.
      </p>
    </div>
  );
}
