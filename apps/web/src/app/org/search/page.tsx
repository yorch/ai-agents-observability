import Link from 'next/link';
import { FilterChips } from '@/components/FilterChips';
import {
  Button,
  ButtonLink,
  Card,
  Cell,
  EmptyState,
  Field,
  FilterPanel,
  Input,
  Pagination,
  Row,
  Select,
  Table,
} from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { fmtDateTime, fmtUsdSession } from '@/lib/fmt';
import { searchSessions, searchTranscripts } from '@/lib/org-queries';
import { getAllRunsPrisma } from '@/lib/prisma';
import { canViewIndividuals, requireOrgViewer } from '@/lib/roles';
export const dynamic = 'force-dynamic';

export default async function OrgSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { orgRole } = await requireOrgViewer();
  const canView = canViewIndividuals(orgRole);
  const { dict } = await getTranslations();

  const params = await searchParams;
  const query = params.q?.trim() ?? '';
  const userId = params.user ?? undefined;
  const teamId = params.team ?? undefined;
  const repoId = params.repo ?? undefined;
  const model = params.model ?? undefined;
  const toolName = params.tool ?? undefined;
  const jiraKey = params.jira ?? undefined;
  const shape = params.shape || undefined;
  const agent = params.agent || undefined;
  const bandRaw = params.band;
  const frictionBand =
    bandRaw === 'low' || bandRaw === 'medium' || bandRaw === 'high' ? bandRaw : undefined;
  const page = Math.max(1, Number(params.page ?? '1') || 1);

  let dateFrom: Date | undefined;
  let dateTo: Date | undefined;
  if (params.from) {
    const d = new Date(params.from);
    if (!Number.isNaN(d.getTime())) {
      dateFrom = d;
    }
  }
  if (params.to) {
    const d = new Date(params.to);
    if (!Number.isNaN(d.getTime())) {
      dateTo = d;
    }
  }

  // Load filter options for dropdowns
  // run-kind-exempt: these are the search *facets* — the counts beside each
  // filter option. They must match what the search itself can return, and
  // org search's run-kind scope is the caller's choice (see search-queries).
  const prisma = getAllRunsPrisma('search facet counts mirror the search scope');
  // Facet dropdowns must respect visibility: a user who opted out of org metadata
  // sharing must not surface their models/shapes/agents in the org facet lists.
  const orgVisibleSession = {
    user: {
      deactivatedAt: null,
      OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
    },
  };
  const [teams, repos, models, shapeFacets, agentFacets] = await Promise.all([
    prisma.team.findMany({
      orderBy: { name: 'asc' },
      select: { githubSlug: true, id: true, name: true },
      take: 100,
    }),
    prisma.repo.findMany({
      orderBy: { githubName: 'asc' },
      select: { githubName: true, githubOwner: true, id: true },
      take: 100,
    }),
    prisma.session.groupBy({
      by: ['primaryModel'],
      orderBy: { _count: { primaryModel: 'desc' } },
      take: 20,
      where: { ...orgVisibleSession, primaryModel: { not: null } },
    }),
    // Available effectiveness/agent facets, visibility-scoped (single GROUP BY each).
    prisma.session.groupBy({
      _count: { _all: true },
      by: ['shapeLabel'],
      where: { ...orgVisibleSession, shapeLabel: { not: null } },
    }),
    prisma.session.groupBy({
      _count: { _all: true },
      by: ['agentType'],
      where: orgVisibleSession,
    }),
  ]);

  // Session search (faceted)
  const sessionResults = canView
    ? await searchSessions(
        {
          agentTypes: agent ? [agent] : undefined,
          dateFrom,
          dateTo,
          frictionBand,
          jiraKey,
          model,
          page,
          repoId,
          shapeLabels: shape ? [shape] : undefined,
          teamId,
          toolName,
          userId,
        },
        canView,
      )
    : { page: 1, pageSize: 50, results: [], total: 0 };

  // Transcript FTS search (if query provided)
  const transcriptResults = query ? await searchTranscripts(query, canView) : [];

  // Applied-filter chips: each links to the URL without that one facet, with
  // ids resolved to the display names the dropdowns show.
  const CHIP_LABELS: Record<string, string> = {
    agent: 'Agent',
    band: 'Friction',
    from: 'From',
    jira: 'Ticket',
    model: 'Model',
    q: 'Query',
    repo: 'Repo',
    shape: 'Shape',
    team: 'Team',
    to: 'To',
    tool: 'Tool',
    user: 'User',
  };
  const chips = Object.entries(CHIP_LABELS)
    .map(([key, label]) => ({ key, label, value: params[key]?.trim() ?? '' }))
    .filter((f) => f.value !== '')
    .map(({ key, label, value }) => {
      let display = value;
      if (key === 'team') {
        display = teams.find((t) => t.id === value)?.name ?? value;
      } else if (key === 'repo') {
        const r = repos.find((x) => x.id === value);
        display = r ? `${r.githubOwner}/${r.githubName}` : value;
      } else if (key === 'user') {
        display = `${value.slice(0, 8)}…`;
      }
      return {
        href: buildUrl(params, { [key]: '', page: '' }),
        label: `${label}: ${display}`,
      };
    });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-text-3 uppercase tracking-wider mb-1">
          {dict.org.search.breadcrumb}
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
          {dict.org.search.title}
        </h1>
        <p className="mt-1 text-sm text-text-2">{dict.org.search.description}</p>
      </div>

      {!canView && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-text-2">
          {dict.org.search.noAccess}
        </div>
      )}

      {canView && (
        <>
          {/* Filters */}
          <FilterPanel label={dict.org.search.sessionFilters}>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label={dict.org.search.filterTeam} htmlFor="filter-team">
                <Select id="filter-team" name="team" defaultValue={teamId ?? ''}>
                  <option value="">{dict.org.search.allTeams}</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={dict.org.search.filterRepo} htmlFor="filter-repo">
                <Select id="filter-repo" name="repo" defaultValue={repoId ?? ''}>
                  <option value="">{dict.org.search.allRepos}</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.githubOwner}/{r.githubName}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={dict.org.search.filterModel} htmlFor="filter-model">
                <Select id="filter-model" name="model" defaultValue={model ?? ''}>
                  <option value="">{dict.org.search.allModels}</option>
                  {models.map((m) => (
                    <option key={m.primaryModel ?? ''} value={m.primaryModel ?? ''}>
                      {m.primaryModel}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={dict.org.search.filterTool} htmlFor="filter-tool">
                <Input
                  id="filter-tool"
                  type="text"
                  name="tool"
                  defaultValue={toolName ?? ''}
                  placeholder="e.g. Edit, Bash"
                />
              </Field>

              <Field label={dict.org.search.filterJira} htmlFor="filter-jira">
                <Input
                  id="filter-jira"
                  type="text"
                  name="jira"
                  defaultValue={jiraKey ?? ''}
                  placeholder="e.g. PROJ-123"
                />
              </Field>

              <Field label={dict.org.search.filterFrom} htmlFor="filter-from">
                <Input
                  id="filter-from"
                  type="date"
                  name="from"
                  defaultValue={dateFrom?.toISOString().split('T')[0] ?? ''}
                />
              </Field>

              <Field label={dict.org.search.filterTo} htmlFor="filter-to">
                <Input
                  id="filter-to"
                  type="date"
                  name="to"
                  defaultValue={dateTo?.toISOString().split('T')[0] ?? ''}
                />
              </Field>

              <Field label={dict.org.search.filterShape} htmlFor="filter-shape">
                <Select id="filter-shape" name="shape" defaultValue={shape ?? ''}>
                  <option value="">{dict.org.search.allShapes}</option>
                  {shapeFacets.map((f) => (
                    <option key={f.shapeLabel ?? ''} value={f.shapeLabel ?? ''}>
                      {f.shapeLabel} ({f._count._all})
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={dict.org.search.filterFriction} htmlFor="filter-band">
                <Select id="filter-band" name="band" defaultValue={frictionBand ?? ''}>
                  <option value="">{dict.org.search.frictionAny}</option>
                  <option value="low">{dict.org.search.frictionLow}</option>
                  <option value="medium">{dict.org.search.frictionMedium}</option>
                  <option value="high">{dict.org.search.frictionHigh}</option>
                </Select>
              </Field>

              <Field label={dict.org.search.filterAgent} htmlFor="filter-agent">
                <Select id="filter-agent" name="agent" defaultValue={agent ?? ''}>
                  <option value="">{dict.org.search.allAgents}</option>
                  {agentFacets.map((f) => (
                    <option key={f.agentType} value={f.agentType}>
                      {f.agentType} ({f._count._all})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* Transcript FTS */}
            <div className="flex gap-3 pt-2 border-t border-border">
              <Input
                type="text"
                name="q"
                defaultValue={query}
                placeholder={dict.org.search.transcriptPlaceholder}
                className="flex-1"
              />
              <Button type="submit">{dict.org.search.submit}</Button>
            </div>
          </FilterPanel>

          <FilterChips chips={chips} clearHref="/org/search" />

          {/* Transcript results */}
          {query && (
            <section className="space-y-3">
              <h2 className="font-display text-sm font-semibold text-text">
                {format(dict.org.search.transcriptMatches, { query })}
                {transcriptResults.length >= 20 && (
                  <span className="ml-2 font-body text-xs font-normal text-text-3">
                    {dict.org.search.top20}
                  </span>
                )}
              </h2>
              {transcriptResults.length === 0 ? (
                <EmptyState>{dict.org.search.emptyTranscript}</EmptyState>
              ) : (
                <div className="space-y-3">
                  {transcriptResults.map((r) => (
                    <Card key={`${r.sessionId}-${r.messageIdx}`} contentClassName="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-text-3">
                        <span className="font-semibold text-text-2">{r.githubLogin}</span>
                        <span>·</span>
                        <Link
                          href={`/org/sessions/${r.sessionId}`}
                          className="text-accent hover:underline font-mono"
                        >
                          {r.sessionId.slice(0, 8)}…
                        </Link>
                        <span>· {r.role}</span>
                        {r.ts && <span>· {fmtDateTime(new Date(r.ts))}</span>}
                      </div>
                      <p
                        className="text-sm text-text-2 leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: r.excerpt }}
                      />
                    </Card>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Session results */}
          <section className="space-y-3">
            <h2 className="font-display text-sm font-semibold text-text">
              {dict.org.search.sessions} {sessionResults.total > 0 && `(${sessionResults.total})`}
            </h2>

            {sessionResults.results.length === 0 ? (
              <EmptyState
                title={dict.org.search.emptyFilters}
                action={
                  chips.length > 0 ? (
                    <ButtonLink variant="secondary" href="/org/search">
                      {dict.org.search.clearFilters}
                    </ButtonLink>
                  ) : undefined
                }
              >
                {dict.org.search.emptyFiltersBody}
              </EmptyState>
            ) : (
              <Table
                columns={[
                  { label: dict.org.search.colUser },
                  { label: dict.org.search.colSession },
                  { label: dict.org.search.colRepo },
                  { label: dict.org.search.colStatus },
                  { align: 'right', label: dict.org.search.colTools },
                  { align: 'right', label: dict.org.search.colCost },
                  { align: 'right', label: dict.org.search.colStarted },
                ]}
              >
                {sessionResults.results.map((s) => (
                  <Row key={s.sessionId}>
                    <Cell>{s.githubLogin}</Cell>
                    <Cell>
                      <Link
                        href={`/org/sessions/${s.sessionId}`}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {s.sessionId.slice(0, 8)}…
                      </Link>
                    </Cell>
                    <Cell className="text-text-2 text-xs">{s.repoName ?? '—'}</Cell>
                    <Cell>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-surface-2 text-text-2">
                        {s.status}
                      </span>
                    </Cell>
                    <Cell num className="text-text-2">
                      {s.toolCallCount}
                    </Cell>
                    <Cell num>{fmtUsdSession(s.costUsd)}</Cell>
                    <Cell num className="text-text-2 text-xs">
                      {fmtDateTime(new Date(s.startedAt))}
                    </Cell>
                  </Row>
                ))}
              </Table>
            )}
            <Pagination
              page={page}
              pageSize={sessionResults.pageSize}
              total={sessionResults.total}
              hrefFor={(n) => buildUrl(params, { page: n })}
              dict={dict}
            />
          </section>
        </>
      )}
    </div>
  );
}

function buildUrl(current: Record<string, string>, overrides: Record<string, string | number>) {
  const p = new URLSearchParams(current);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === '') {
      p.delete(k);
    } else {
      p.set(k, String(v));
    }
  }
  return `/org/search?${p.toString()}`;
}
