import { ModelMixChart } from '../../../components/me/ModelMix';
import { TopTools } from '../../../components/me/TopTools';
import { requireTeamLead } from '../../../lib/roles';
import {
  getTeamModelMix,
  getTeamSummary,
  getTeamTopTools,
  resolveTeamVisibility,
} from '../../../lib/team-queries';
import { daysAgo } from '../../../lib/time';
import { TeamSubNav } from './layout';

export const dynamic = 'force-dynamic';

export default async function TeamOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { teamId, teamName } = await requireTeamLead(slug);

  const since = daysAgo(30);
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
          <TopTools title="Top Tools" tools={tools} />
          <ModelMixChart models={models} />
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
