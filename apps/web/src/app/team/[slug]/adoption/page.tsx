import { PageHeader } from '@/components/team-org/PageHeader';
import { Card, SectionHeader, Stat } from '@/components/ui';
import { requireTeamLead } from '@/lib/roles';
import { getTeamSessionFrequencyDistribution, resolveTeamVisibility } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';

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
      <PageHeader
        breadcrumb="Team"
        description={`Adoption · trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total members" value={totalCount.toString()} />
        <Stat label={`Active (${range}d)`} value={activeCount.toString()} />
        <Stat label="Adoption rate" value={`${Math.round(adoptionRate * 100)}%`} />
      </div>

      <Card>
        <SectionHeader>Session frequency distribution</SectionHeader>
        <div className="space-y-3">
          {distribution.map((b) => (
            <div key={b.bucket}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm text-text">{b.bucket}</span>
                <span className="font-mono text-sm text-text-2">
                  {b.userCount} member{b.userCount !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="h-2 rounded-full bg-surface-2">
                <div
                  className="h-2 rounded-full bg-accent transition-all"
                  style={{ width: `${(b.userCount / maxCount) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-text-3">
          Based on {visibleIds.length} of {totalCount} members who share metadata. Buckets: Inactive
          = 0 sessions, Light = 1–4, Moderate = 5–19, Active = 20–49, Power = 50+.
        </p>
      </Card>
    </div>
  );
}
