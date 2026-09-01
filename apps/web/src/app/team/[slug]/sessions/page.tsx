import { TeamSessionsTable } from '@/components/team/TeamSessionsTable';
import { ActiveSessionStream } from '@/components/team-org/ActiveSessionStream';
import { Card } from '@/components/ui';
import { requireTeamLead } from '@/lib/roles';
import { listTeamSessions, resolveTeamVisibility } from '@/lib/team-queries';

export const dynamic = 'force-dynamic';

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** `Math.max(1, parseInt('abc', 10))` is NaN — which reaches Prisma and throws. */
function parsePage(raw: string | undefined): number {
  return Math.max(1, Number(raw ?? '1') || 1);
}

export default async function TeamSessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; page?: string; repo?: string; to?: string }>;
}) {
  const [{ slug }, search] = await Promise.all([params, searchParams]);
  const { teamId, teamName } = await requireTeamLead(slug);

  const { visibleIds, totalCount } = await resolveTeamVisibility(teamId);
  const page = parsePage(search.page);
  const from = parseDate(search.from);
  const to = parseDate(search.to);
  const { sessions, total } = await listTeamSessions(visibleIds, {
    from,
    page,
    repo: search.repo,
    to,
  });

  const hiddenCount = totalCount - visibleIds.length;
  const filtered = Boolean(from || to || search.repo);

  // The pager has to carry the active filters; dropping them on page 2 has been
  // a shipped bug in this app before.
  const hrefFor = (nextPage: number) => {
    const query = new URLSearchParams();
    if (search.from) {
      query.set('from', search.from);
    }
    if (search.to) {
      query.set('to', search.to);
    }
    if (search.repo) {
      query.set('repo', search.repo);
    }
    query.set('page', String(nextPage));
    return `?${query.toString()}`;
  };

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

      {/* An active filter has to be visible and removable — a drill-in from the
          report lands here with a window applied, and a count that silently
          disagrees with an unfiltered list is worse than no drill-in at all. */}
      {filtered && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-text-3">Filtered to</span>
          {search.repo && (
            <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs text-text-2">
              {search.repo}
            </span>
          )}
          {(from || to) && (
            <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs text-text-2">
              {search.from ?? '…'} → {search.to ?? '…'}
            </span>
          )}
          <a href={`/team/${slug}/sessions`} className="text-accent hover:underline">
            Clear
          </a>
        </div>
      )}

      {/* E4: Real-time active sessions stream */}
      <Card
        contentClassName="space-y-3"
        title="Active sessions"
        caption="Live view of in-progress sessions for visible team members. Updates every few seconds."
      >
        <ActiveSessionStream slug={slug} />
      </Card>

      <TeamSessionsTable
        sessions={sessions}
        total={total}
        currentPage={page}
        slug={slug}
        hrefFor={hrefFor}
      />
    </div>
  );
}
