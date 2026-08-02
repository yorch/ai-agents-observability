import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons';
import { Button, Card, Cell, Field, Input, Row, Select, Table } from '@/components/ui';
import { searchSessions, searchTranscripts } from '@/lib/org-queries';
import { getPrisma } from '@/lib/prisma';
import { canViewIndividuals, requireOrgViewer } from '@/lib/roles';
export const dynamic = 'force-dynamic';

export default async function OrgSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { orgRole } = await requireOrgViewer();
  const canView = canViewIndividuals(orgRole);

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
  const prisma = getPrisma();
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

  const totalPages = Math.ceil(sessionResults.total / sessionResults.pageSize);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-text-3 uppercase tracking-wider mb-1">Org</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">Search</h1>
        <p className="mt-1 text-sm text-text-2">
          Faceted session search · transcript full-text search
        </p>
      </div>

      {!canView && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-text-2">
          Individual session search is not available for your role. You can view aggregate data on
          the dashboard.
        </div>
      )}

      {canView && (
        <>
          {/* Filters */}
          <form method="GET" className="rounded-lg border border-border bg-surface p-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Team" htmlFor="filter-team">
                <Select id="filter-team" name="team" defaultValue={teamId ?? ''}>
                  <option value="">All teams</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Repo" htmlFor="filter-repo">
                <Select id="filter-repo" name="repo" defaultValue={repoId ?? ''}>
                  <option value="">All repos</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.githubOwner}/{r.githubName}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Model" htmlFor="filter-model">
                <Select id="filter-model" name="model" defaultValue={model ?? ''}>
                  <option value="">All models</option>
                  {models.map((m) => (
                    <option key={m.primaryModel ?? ''} value={m.primaryModel ?? ''}>
                      {m.primaryModel}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Tool" htmlFor="filter-tool">
                <Input
                  id="filter-tool"
                  type="text"
                  name="tool"
                  defaultValue={toolName ?? ''}
                  placeholder="e.g. Edit, Bash"
                />
              </Field>

              <Field label="Jira ticket" htmlFor="filter-jira">
                <Input
                  id="filter-jira"
                  type="text"
                  name="jira"
                  defaultValue={jiraKey ?? ''}
                  placeholder="e.g. PROJ-123"
                />
              </Field>

              <Field label="From" htmlFor="filter-from">
                <Input
                  id="filter-from"
                  type="date"
                  name="from"
                  defaultValue={dateFrom?.toISOString().split('T')[0] ?? ''}
                />
              </Field>

              <Field label="To" htmlFor="filter-to">
                <Input
                  id="filter-to"
                  type="date"
                  name="to"
                  defaultValue={dateTo?.toISOString().split('T')[0] ?? ''}
                />
              </Field>

              <Field label="Session shape" htmlFor="filter-shape">
                <Select id="filter-shape" name="shape" defaultValue={shape ?? ''}>
                  <option value="">All shapes</option>
                  {shapeFacets.map((f) => (
                    <option key={f.shapeLabel ?? ''} value={f.shapeLabel ?? ''}>
                      {f.shapeLabel} ({f._count._all})
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Friction band" htmlFor="filter-band">
                <Select id="filter-band" name="band" defaultValue={frictionBand ?? ''}>
                  <option value="">Any friction</option>
                  <option value="low">Low (&lt; 0.3)</option>
                  <option value="medium">Medium (0.3–0.6)</option>
                  <option value="high">High (&gt; 0.6)</option>
                </Select>
              </Field>

              <Field label="Agent" htmlFor="filter-agent">
                <Select id="filter-agent" name="agent" defaultValue={agent ?? ''}>
                  <option value="">All agents</option>
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
                placeholder="Search transcript content (users with org sharing enabled)"
                className="flex-1"
              />
              <Button type="submit">Search</Button>
            </div>
          </form>

          {/* Transcript results */}
          {query && (
            <section className="space-y-3">
              <h2 className="font-display text-sm font-semibold text-text">
                Transcript matches for &quot;{query}&quot;
              </h2>
              {transcriptResults.length === 0 ? (
                <p className="text-sm text-text-3">
                  No transcript matches. (Only sessions from users who have enabled org transcript
                  sharing are searched.)
                </p>
              ) : (
                <div className="space-y-3">
                  {transcriptResults.map((r) => (
                    <Card key={`${r.sessionId}-${r.messageIdx}`} contentClassName="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-text-3">
                        <span className="font-semibold text-text-2">{r.githubLogin}</span>
                        <span>·</span>
                        <a
                          href={`/org/sessions/${r.sessionId}`}
                          className="text-accent hover:underline font-mono"
                        >
                          {r.sessionId.slice(0, 8)}…
                        </a>
                        <span>· {r.role}</span>
                        {r.ts && <span>· {new Date(r.ts).toLocaleString()}</span>}
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
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-text">
                Sessions {sessionResults.total > 0 && `(${sessionResults.total})`}
              </h2>
              {totalPages > 1 && (
                <div className="flex items-center gap-2 text-sm">
                  {page > 1 && (
                    <a
                      href={buildUrl(params, { page: page - 1 })}
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      <ArrowLeftIcon /> Prev
                    </a>
                  )}
                  <span className="text-text-3">
                    {page} / {totalPages}
                  </span>
                  {page < totalPages && (
                    <a
                      href={buildUrl(params, { page: page + 1 })}
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      Next <ArrowRightIcon />
                    </a>
                  )}
                </div>
              )}
            </div>

            {sessionResults.results.length === 0 ? (
              <p className="text-sm text-text-3">No sessions match the current filters.</p>
            ) : (
              <Table
                columns={[
                  { label: 'User' },
                  { label: 'Session' },
                  { label: 'Repo' },
                  { label: 'Status' },
                  { align: 'right', label: 'Tools' },
                  { align: 'right', label: 'Cost' },
                  { align: 'right', label: 'Started' },
                ]}
              >
                {sessionResults.results.map((s) => (
                  <Row key={s.sessionId}>
                    <Cell>{s.githubLogin}</Cell>
                    <Cell>
                      <a
                        href={`/org/sessions/${s.sessionId}`}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {s.sessionId.slice(0, 8)}…
                      </a>
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
                    <Cell num>${s.costUsd.toFixed(4)}</Cell>
                    <Cell num className="text-text-2 text-xs">
                      {new Date(s.startedAt).toLocaleString()}
                    </Cell>
                  </Row>
                ))}
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function buildUrl(current: Record<string, string>, overrides: Record<string, string | number>) {
  const p = new URLSearchParams(current);
  for (const [k, v] of Object.entries(overrides)) {
    p.set(k, String(v));
  }
  return `/org/search?${p.toString()}`;
}
