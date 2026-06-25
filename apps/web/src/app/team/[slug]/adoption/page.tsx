import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { requireTeamLead } from '@/lib/roles';
import { getTeamSessionFrequencyDistribution, resolveTeamVisibility } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { TeamSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function TeamAdoptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;

  const { teamId, teamName } = await requireTeamLead(slug);
  const since = daysAgo(range);

  const { visibleIds, totalCount } = await resolveTeamVisibility(teamId);
  const distribution = await getTeamSessionFrequencyDistribution(visibleIds, since);

  const activeCount = distribution
    .filter((b) => b.bucket !== 'Inactive')
    .reduce((s, b) => s + b.userCount, 0);
  const adoptionRate = totalCount > 0 ? activeCount / totalCount : 0;
  const maxCount = Math.max(...distribution.map((b) => b.userCount), 1);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Team</p>
          <h1 className="text-2xl font-semibold">{teamName}</h1>
          <p className="mt-1 text-sm text-white/50">Adoption · trailing {range} days</p>
        </div>
        <DateRangePicker range={range} />
      </div>

      <TeamSubNav slug={slug} active="adoption" />

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total members', value: totalCount.toString() },
          { label: `Active (${range}d)`, value: activeCount.toString() },
          { label: 'Adoption rate', value: `${Math.round(adoptionRate * 100)}%` },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-white/10 bg-white/5 p-4">
            <p className="text-xs text-white/40 uppercase tracking-wider">{c.label}</p>
            <p className="mt-1 text-2xl font-semibold font-mono">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Frequency distribution */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-xs text-white/40 uppercase tracking-widest mb-4">
          Session frequency distribution
        </h3>
        <div className="space-y-3">
          {distribution.map((b) => (
            <div key={b.bucket}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-white/80">{b.bucket}</span>
                <span className="text-sm font-mono text-white/50">
                  {b.userCount} member{b.userCount !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="h-2 rounded-full bg-white/10">
                <div
                  className="h-2 rounded-full bg-accent transition-all"
                  style={{ width: `${(b.userCount / maxCount) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-white/30">
          Based on {visibleIds.length} of {totalCount} members who share metadata. Buckets: Inactive
          = 0 sessions, Light = 1–4, Moderate = 5–19, Active = 20–49, Power = 50+.
        </p>
      </div>
    </div>
  );
}
