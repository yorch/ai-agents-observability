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
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Org</p>
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="mt-1 text-sm text-white/50">
          Faceted session search · transcript full-text search
        </p>
      </div>

      {!canView && (
        <div className="rounded-lg border border-white/10 p-6 text-center text-sm text-white/50">
          Individual session search is not available for your role. You can view aggregate data on
          the dashboard.
        </div>
      )}

      {canView && (
        <>
          {/* Filters */}
          <form method="GET" className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <label
                  htmlFor="filter-team"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  Team
                </label>
                <select
                  id="filter-team"
                  name="team"
                  defaultValue={teamId ?? ''}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="">All teams</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-repo"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  Repo
                </label>
                <select
                  id="filter-repo"
                  name="repo"
                  defaultValue={repoId ?? ''}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="">All repos</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.githubOwner}/{r.githubName}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-model"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  Model
                </label>
                <select
                  id="filter-model"
                  name="model"
                  defaultValue={model ?? ''}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="">All models</option>
                  {models.map((m) => (
                    <option key={m.primaryModel ?? ''} value={m.primaryModel ?? ''}>
                      {m.primaryModel}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-tool"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  Tool
                </label>
                <input
                  id="filter-tool"
                  type="text"
                  name="tool"
                  defaultValue={toolName ?? ''}
                  placeholder="e.g. Edit, Bash"
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-jira"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  Jira ticket
                </label>
                <input
                  id="filter-jira"
                  type="text"
                  name="jira"
                  defaultValue={jiraKey ?? ''}
                  placeholder="e.g. PROJ-123"
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-from"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  From
                </label>
                <input
                  id="filter-from"
                  type="date"
                  name="from"
                  defaultValue={dateFrom?.toISOString().split('T')[0] ?? ''}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-to"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  To
                </label>
                <input
                  id="filter-to"
                  type="date"
                  name="to"
                  defaultValue={dateTo?.toISOString().split('T')[0] ?? ''}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-shape"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  Session shape
                </label>
                <select
                  id="filter-shape"
                  name="shape"
                  defaultValue={shape ?? ''}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="">All shapes</option>
                  {shapeFacets.map((f) => (
                    <option key={f.shapeLabel ?? ''} value={f.shapeLabel ?? ''}>
                      {f.shapeLabel} ({f._count._all})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-band"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  Friction band
                </label>
                <select
                  id="filter-band"
                  name="band"
                  defaultValue={frictionBand ?? ''}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="">Any friction</option>
                  <option value="low">Low (&lt; 0.3)</option>
                  <option value="medium">Medium (0.3–0.6)</option>
                  <option value="high">High (&gt; 0.6)</option>
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="filter-agent"
                  className="text-xs text-white/50 uppercase tracking-wide"
                >
                  Agent
                </label>
                <select
                  id="filter-agent"
                  name="agent"
                  defaultValue={agent ?? ''}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
                >
                  <option value="">All agents</option>
                  {agentFacets.map((f) => (
                    <option key={f.agentType} value={f.agentType}>
                      {f.agentType} ({f._count._all})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Transcript FTS */}
            <div className="flex gap-3 pt-2 border-t border-white/10">
              <input
                type="text"
                name="q"
                defaultValue={query}
                placeholder="Search transcript content (users with org sharing enabled)"
                className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-bg hover:bg-brand-600"
              >
                Search
              </button>
            </div>
          </form>

          {/* Transcript results */}
          {query && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-white/70">
                Transcript matches for &quot;{query}&quot;
              </h2>
              {transcriptResults.length === 0 ? (
                <p className="text-sm text-white/40">
                  No transcript matches. (Only sessions from users who have enabled org transcript
                  sharing are searched.)
                </p>
              ) : (
                <div className="space-y-3">
                  {transcriptResults.map((r) => (
                    <div
                      key={`${r.sessionId}-${r.messageIdx}`}
                      className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-2"
                    >
                      <div className="flex items-center gap-2 text-xs text-white/40">
                        <span className="font-semibold text-white/60">{r.githubLogin}</span>
                        <span>·</span>
                        <a
                          href={`/org/sessions/${r.sessionId}`}
                          className="text-brand-400 hover:underline font-mono"
                        >
                          {r.sessionId.slice(0, 8)}…
                        </a>
                        <span>· {r.role}</span>
                        {r.ts && <span>· {new Date(r.ts).toLocaleString()}</span>}
                      </div>
                      <p
                        className="text-sm text-white/70 leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: r.excerpt }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Session results */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white/70">
                Sessions {sessionResults.total > 0 && `(${sessionResults.total})`}
              </h2>
              {totalPages > 1 && (
                <div className="flex items-center gap-2 text-sm">
                  {page > 1 && (
                    <a
                      href={buildUrl(params, { page: page - 1 })}
                      className="text-brand-400 hover:underline"
                    >
                      ← Prev
                    </a>
                  )}
                  <span className="text-white/40">
                    {page} / {totalPages}
                  </span>
                  {page < totalPages && (
                    <a
                      href={buildUrl(params, { page: page + 1 })}
                      className="text-brand-400 hover:underline"
                    >
                      Next →
                    </a>
                  )}
                </div>
              )}
            </div>

            {sessionResults.results.length === 0 ? (
              <p className="text-sm text-white/40">No sessions match the current filters.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-white/40 text-left border-b border-white/10">
                      <th className="pb-2 font-medium">User</th>
                      <th className="pb-2 font-medium">Session</th>
                      <th className="pb-2 font-medium">Repo</th>
                      <th className="pb-2 font-medium">Status</th>
                      <th className="pb-2 font-medium text-right">Tools</th>
                      <th className="pb-2 font-medium text-right">Cost</th>
                      <th className="pb-2 font-medium text-right">Started</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {sessionResults.results.map((s) => (
                      <tr key={s.sessionId}>
                        <td className="py-2">{s.githubLogin}</td>
                        <td className="py-2">
                          <a
                            href={`/org/sessions/${s.sessionId}`}
                            className="font-mono text-xs text-brand-400 hover:underline"
                          >
                            {s.sessionId.slice(0, 8)}…
                          </a>
                        </td>
                        <td className="py-2 text-white/60 text-xs">{s.repoName ?? '—'}</td>
                        <td className="py-2">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-white/60">
                            {s.status}
                          </span>
                        </td>
                        <td className="py-2 text-right text-white/60">{s.toolCallCount}</td>
                        <td className="py-2 text-right font-mono">${s.costUsd.toFixed(4)}</td>
                        <td className="py-2 text-right text-white/50 text-xs">
                          {new Date(s.startedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
