import { PERMISSION_MODES } from '@ai-agents-observability/schemas';
import { redirect } from 'next/navigation';
import { SessionsTable } from '@/components/me/SessionsTable';
import { currentUser } from '@/lib/auth';
import { getJiraBase } from '@/lib/config';
import { getPrisma } from '@/lib/prisma';
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

const selectClass =
  'rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

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

  const [{ sessions, total }, repos, agentFacets, shapeFacets] = await Promise.all([
    listSessions(user.id, sessionOpts),
    listDistinctRepos(user.id),
    getPrisma().session.groupBy({ by: ['agentType'], where: { userId: user.id } }),
    getPrisma().session.groupBy({
      by: ['shapeLabel'],
      orderBy: { _count: { shapeLabel: 'desc' } },
      where: { shapeLabel: { not: null }, userId: user.id },
    }),
  ]);
  const agentTypes = agentFacets.map((f) => f.agentType);
  const shapeLabels = shapeFacets.map((f) => f.shapeLabel as string);

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text">Sessions</h1>

      <form method="GET" className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="repo-filter" className="text-xs text-text-3">
            Repo
          </label>
          <select id="repo-filter" name="repo" defaultValue={repo ?? ''} className={selectClass}>
            <option value="">All repos</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="status-filter" className="text-xs text-text-3">
            Status
          </label>
          <select
            id="status-filter"
            name="status"
            defaultValue={status ?? ''}
            className={selectClass}
          >
            <option value="">All statuses</option>
            {SESSION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="from-filter" className="text-xs text-text-3">
            From
          </label>
          <input
            id="from-filter"
            type="date"
            name="from"
            defaultValue={params.from ?? ''}
            className={selectClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="to-filter" className="text-xs text-text-3">
            To
          </label>
          <input
            id="to-filter"
            type="date"
            name="to"
            defaultValue={params.to ?? ''}
            className={selectClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="shape-filter" className="text-xs text-text-3">
            Shape
          </label>
          <select id="shape-filter" name="shape" defaultValue={shape ?? ''} className={selectClass}>
            <option value="">All shapes</option>
            {shapeLabels.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="band-filter" className="text-xs text-text-3">
            Friction
          </label>
          <select
            id="band-filter"
            name="band"
            defaultValue={frictionBand ?? ''}
            className={selectClass}
          >
            <option value="">Any</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="mode-filter" className="text-xs text-text-3">
            Mode
          </label>
          <select id="mode-filter" name="mode" defaultValue={mode ?? ''} className={selectClass}>
            <option value="">All modes</option>
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {agentTypes.length > 1 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-filter" className="text-xs text-text-3">
              Agent
            </label>
            <select
              id="agent-filter"
              name="agent"
              defaultValue={agent ?? ''}
              className={selectClass}
            >
              <option value="">All agents</option>
              {agentTypes.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        )}

        <button
          type="submit"
          className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-bg hover:opacity-90 transition-opacity"
        >
          Filter
        </button>

        {(repo || status || params.from || params.to || shape || agent || frictionBand || mode) && (
          <a
            href="/me/sessions"
            className="rounded-lg border border-border px-4 py-1.5 text-sm text-text-2 hover:border-accent hover:text-accent transition-colors"
          >
            Clear
          </a>
        )}
      </form>

      {/* Export */}
      <div className="flex justify-end">
        <a
          href={buildExportUrl({
            agent,
            band: frictionBand,
            from: params.from,
            mode,
            repo,
            shape,
            status,
            to: params.to,
          })}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-text-3 hover:text-text hover:bg-surface-2 transition-colors"
        >
          Export CSV
        </a>
      </div>

      <SessionsTable
        sessions={sessions}
        total={total}
        currentPage={page}
        jiraBase={getJiraBase()}
      />
    </div>
  );
}
