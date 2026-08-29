import { PERMISSION_MODES } from '@ai-agents-observability/schemas';
import { redirect } from 'next/navigation';
import { FilterChips } from '@/components/FilterChips';
import { SessionsTable } from '@/components/me/SessionsTable';
import { Button, ButtonLink, EmptyState, Field, FilterPanel, Input, Select } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { currentUser } from '@/lib/auth';
import { getJiraBase } from '@/lib/config';
import { getAllRunsPrisma } from '@/lib/prisma';
import { type FrictionBand, listDistinctRepos, listSessions } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

function buildExportUrl(filters: {
  agent?: string | undefined;
  band?: string | undefined;
  from?: string | undefined;
  mode?: string | undefined;
  repo?: string | undefined;
  shape?: string | undefined;
  status?: string | undefined;
  to?: string | undefined;
}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) {
      p.set(k, v);
    }
  }
  return `/api/me/export?${p.toString()}`;
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) {
    return undefined;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const SESSION_STATUSES = ['ACTIVE', 'COMPLETED', 'CRASHED', 'TIMED_OUT', 'ABANDONED'] as const;

function parseBand(s: string | undefined): FrictionBand | undefined {
  return s === 'low' || s === 'medium' || s === 'high' ? s : undefined;
}

type SearchParams = {
  agent?: string;
  band?: string;
  from?: string;
  mode?: string;
  page?: string;
  repo?: string;
  shape?: string;
  status?: string;
  to?: string;
};

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const { dict } = await getTranslations();
  const STATUS_LABELS: Record<string, string> = {
    ABANDONED: dict.me.sessions.statusAbandoned,
    ACTIVE: dict.me.sessions.statusActive,
    COMPLETED: dict.me.sessions.statusCompleted,
    CRASHED: dict.me.sessions.statusCrashed,
    TIMED_OUT: dict.me.sessions.statusTimedOut,
  };
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? '1', 10));
  const repo = params.repo || undefined;
  const status = params.status || undefined;
  const shape = params.shape || undefined;
  const agent = params.agent || undefined;
  const mode = (PERMISSION_MODES as readonly string[]).includes(params.mode ?? '')
    ? params.mode
    : undefined;
  const frictionBand = parseBand(params.band);
  const dateFrom = parseDate(params.from);
  const dateTo = parseDate(params.to);

  const sessionOpts = {
    page,
    ...(repo ? { repo } : {}),
    ...(status ? { status } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(shape ? { shapeLabels: [shape] } : {}),
    ...(agent ? { agentTypes: [agent] } : {}),
    ...(frictionBand ? { frictionBand } : {}),
    ...(mode ? { mode } : {}),
  };

  const facetDb = getAllRunsPrisma("own-data facet counts include the caller's own CI runs");
  const [{ sessions, total }, repos, agentFacets, shapeFacets] = await Promise.all([
    listSessions(user.id, sessionOpts),
    listDistinctRepos(user.id),
    // run-kind-exempt: facet counts beside a developer's own session filters.
    // They must match what the list can show — and a developer's own CI runs are
    // theirs to see, even though they stay out of every aggregate.
    facetDb.session.groupBy({ by: ['agentType'], where: { userId: user.id } }),
    facetDb.session.groupBy({
      by: ['shapeLabel'],
      orderBy: { _count: { shapeLabel: 'desc' } },
      where: { shapeLabel: { not: null }, userId: user.id },
    }),
  ]);
  const agentTypes = agentFacets.map((f) => f.agentType);
  const shapeLabels = shapeFacets.map((f) => f.shapeLabel as string);

  // One list, so the Clear button, the export URL, and the pager cannot
  // disagree about what counts as a filter.
  const filters = {
    agent,
    band: frictionBand,
    from: params.from,
    mode,
    repo,
    shape,
    status,
    to: params.to,
  };

  // The pager must carry the active filters, or moving to page 2 clears them.
  const hrefForPage = (n: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) {
        p.set(k, v);
      }
    }
    p.set('page', String(n));
    return `?${p.toString()}`;
  };

  // Chips mirror the same filter object; each one links to the URL without
  // itself, so removing a facet is one click instead of a form round-trip.
  const CHIP_LABELS: Record<string, string> = {
    agent: dict.common.filterAgent,
    band: dict.common.filterBand,
    from: dict.common.filterFrom,
    mode: dict.common.filterMode,
    repo: dict.common.filterRepo,
    shape: dict.common.filterShape,
    status: dict.common.filterStatus,
    to: dict.common.filterTo,
  };
  const chips = Object.entries(filters)
    .filter(([, v]) => Boolean(v))
    .map(([key, value]) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) {
        if (v && k !== key) {
          p.set(k, v);
        }
      }
      const qs = p.toString();
      return { href: qs ? `?${qs}` : '/me/sessions', label: `${CHIP_LABELS[key]}: ${value}` };
    });
  const hasFilters = chips.length > 0;

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
        {dict.me.sessions.title}
      </h1>

      {/* These filters wrap badly in a row; the same grid the org search uses
          keeps the labels readable and the controls on one baseline. */}
      <FilterPanel label={dict.me.sessions.filterPanelLabel}>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={dict.common.filterRepo} htmlFor="repo-filter">
            <Select id="repo-filter" name="repo" defaultValue={repo ?? ''}>
              <option value="">{dict.me.sessions.allRepos}</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={dict.common.filterStatus} htmlFor="status-filter">
            <Select id="status-filter" name="status" defaultValue={status ?? ''}>
              <option value="">{dict.me.sessions.allStatuses}</option>
              {SESSION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={dict.common.filterShape} htmlFor="shape-filter">
            <Select id="shape-filter" name="shape" defaultValue={shape ?? ''}>
              <option value="">{dict.me.sessions.allShapes}</option>
              {shapeLabels.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={dict.common.filterBand} htmlFor="band-filter">
            <Select id="band-filter" name="band" defaultValue={frictionBand ?? ''}>
              <option value="">{dict.me.sessions.frictionAny}</option>
              <option value="low">{dict.me.sessions.frictionLow}</option>
              <option value="medium">{dict.me.sessions.frictionMedium}</option>
              <option value="high">{dict.me.sessions.frictionHigh}</option>
            </Select>
          </Field>

          <Field label={dict.common.filterMode} htmlFor="mode-filter">
            <Select id="mode-filter" name="mode" defaultValue={mode ?? ''}>
              <option value="">{dict.me.sessions.allModes}</option>
              {PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>

          {agentTypes.length > 1 && (
            <Field label={dict.common.filterAgent} htmlFor="agent-filter">
              <Select id="agent-filter" name="agent" defaultValue={agent ?? ''}>
                <option value="">{dict.me.sessions.allAgents}</option>
                {agentTypes.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label={dict.common.filterFrom} htmlFor="from-filter">
            <Input id="from-filter" type="date" name="from" defaultValue={params.from ?? ''} />
          </Field>

          <Field label={dict.common.filterTo} htmlFor="to-filter">
            <Input id="to-filter" type="date" name="to" defaultValue={params.to ?? ''} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button type="submit">{dict.me.sessions.filter}</Button>

          {Object.values(filters).some(Boolean) && (
            <ButtonLink variant="secondary" href="/me/sessions">
              {dict.me.sessions.clear}
            </ButtonLink>
          )}

          <ButtonLink className="ml-auto" variant="secondary" href={buildExportUrl(filters)}>
            {dict.me.sessions.exportCsv}
          </ButtonLink>
        </div>
      </FilterPanel>

      <FilterChips chips={chips} clearHref="/me/sessions" />

      {sessions.length === 0 ? (
        hasFilters ? (
          <EmptyState
            title={dict.me.sessions.emptyFiltered}
            action={
              <ButtonLink variant="secondary" href="/me/sessions">
                {dict.me.sessions.clearFilters}
              </ButtonLink>
            }
          >
            {dict.me.sessions.emptyFilteredBody}
          </EmptyState>
        ) : total > 0 ? (
          // An out-of-range ?page= (stale bookmark, pruned history) is not a
          // first run — the install CTA here would tell an onboarded user to
          // reinstall.
          <EmptyState
            title={dict.me.sessions.emptyPage}
            action={
              <ButtonLink variant="secondary" href="/me/sessions">
                {dict.me.sessions.backToPage1}
              </ButtonLink>
            }
          >
            {dict.me.sessions.emptyPageBody}
          </EmptyState>
        ) : (
          <EmptyState
            title={dict.me.sessions.empty}
            action={<ButtonLink href="/install">{dict.me.sessions.installHook}</ButtonLink>}
          >
            {dict.me.sessions.emptyBody}
          </EmptyState>
        )
      ) : (
        <SessionsTable
          sessions={sessions}
          total={total}
          currentPage={page}
          hrefFor={hrefForPage}
          jiraBase={getJiraBase()}
        />
      )}
    </div>
  );
}
