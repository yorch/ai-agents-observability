import { FilterChips } from '@/components/FilterChips';
import { TeamSessionsTable } from '@/components/team/TeamSessionsTable';
import { ActiveSessionStream } from '@/components/team-org/ActiveSessionStream';
import { Button, Card, Field, FilterPanel, Input, Select } from '@/components/ui';
import { requireTeamLead } from '@/lib/roles';
import { listTeamSessions, resolveTeamVisibility } from '@/lib/team-queries';
import { listTrendRepos } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

const SESSION_STATUSES = ['ACTIVE', 'COMPLETED', 'CRASHED', 'TIMED_OUT', 'ABANDONED'] as const;

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

type SearchParams = {
  from?: string;
  page?: string;
  repo?: string;
  status?: string;
  to?: string;
};

const CHIP_LABELS: Record<string, string> = {
  from: 'From',
  repo: 'Repo',
  status: 'Status',
  to: 'To',
};

export default async function TeamSessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ slug }, search] = await Promise.all([params, searchParams]);
  const { teamId, teamName } = await requireTeamLead(slug);

  const { visibleIds, totalCount } = await resolveTeamVisibility(teamId);
  const page = parsePage(search.page);
  const status = SESSION_STATUSES.includes(search.status as (typeof SESSION_STATUSES)[number])
    ? search.status
    : undefined;

  const [{ sessions, total }, repos] = await Promise.all([
    listTeamSessions(visibleIds, {
      from: parseDate(search.from),
      page,
      repo: search.repo,
      status,
      to: parseDate(search.to),
    }),
    listTrendRepos(visibleIds),
  ]);

  const hiddenCount = totalCount - visibleIds.length;

  // Active filters as removable chips, and a pager that carries them — dropping
  // filters on page 2 has shipped in this app before.
  const active: Record<string, string | undefined> = {
    from: search.from,
    repo: search.repo,
    status,
    to: search.to,
  };
  const basePath = `/team/${slug}/sessions`;
  const chips = Object.entries(active)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(active)) {
        if (v && k !== key) {
          query.set(k, v);
        }
      }
      const qs = query.toString();
      return { href: qs ? `?${qs}` : basePath, label: `${CHIP_LABELS[key]}: ${value}` };
    });

  const hrefFor = (nextPage: number) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(active)) {
      if (v) {
        query.set(k, v);
      }
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

      {/* Leads had pagination and nothing else, while /me/sessions has a full
          facet set over the same shape of data — and the report drilled in here
          with a window this page then ignored. */}
      <FilterPanel label="Session filters">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Repo" htmlFor="team-repo-filter">
            <Select id="team-repo-filter" name="repo" defaultValue={search.repo ?? ''}>
              <option value="">All repos</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="team-status-filter">
            <Select id="team-status-filter" name="status" defaultValue={status ?? ''}>
              <option value="">All statuses</option>
              {SESSION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" htmlFor="team-from-filter">
            <Input id="team-from-filter" type="date" name="from" defaultValue={search.from} />
          </Field>
          <Field label="To" htmlFor="team-to-filter">
            <Input id="team-to-filter" type="date" name="to" defaultValue={search.to} />
          </Field>
        </div>
        <Button type="submit" size="sm">
          Filter
        </Button>
      </FilterPanel>

      <FilterChips chips={chips} clearHref={basePath} />

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
