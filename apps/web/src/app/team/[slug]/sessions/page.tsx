import { TeamSessionsTable } from '@/components/team/TeamSessionsTable';
import { ActiveSessionStream } from '@/components/team-org/ActiveSessionStream';
import { Card } from '@/components/ui';
import { requireTeamLead } from '@/lib/roles';
import { listTeamSessions, resolveTeamVisibility } from '@/lib/team-queries';

export const dynamic = 'force-dynamic';

export default async function TeamSessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await params;
  const { teamId, teamName } = await requireTeamLead(slug);

  const { visibleIds, totalCount } = await resolveTeamVisibility(teamId);
  const page = Math.max(1, parseInt((await searchParams).page ?? '1', 10));
  const { sessions, total } = await listTeamSessions(visibleIds, { page });

  const hiddenCount = totalCount - visibleIds.length;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-text-3 uppercase tracking-wider mb-1">Team</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">{teamName}</h1>
        <p className="mt-1 text-sm text-text-2">
          {total} sessions across {visibleIds.length} member
          {visibleIds.length !== 1 ? 's' : ''}
          {hiddenCount > 0 && (
            <span className="ml-1 text-text-3">
              ({hiddenCount} member{hiddenCount !== 1 ? 's' : ''} opted out of sharing)
            </span>
          )}
        </p>
      </div>

      {/* E4: Real-time active sessions stream */}
      <Card
        contentClassName="space-y-3"
        title="Active sessions"
        caption="Live view of in-progress sessions for visible team members. Updates every few seconds."
      >
        <ActiveSessionStream slug={slug} />
      </Card>

      <TeamSessionsTable sessions={sessions} total={total} currentPage={page} slug={slug} />
    </div>
  );
}
