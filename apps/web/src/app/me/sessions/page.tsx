import { PERMISSION_MODES } from '@ai-agents-observability/schemas';
import { redirect } from 'next/navigation';
import { SessionsTable } from '@/components/me/SessionsTable';
import { Button, ButtonLink, Field, Input, Select } from '@/components/ui';
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

      {/* Eight filters wrap badly in a row; the same grid the org search uses
          keeps the labels readable and the controls on one baseline. */}
      <form
        method="GET"
        className="space-y-4 rounded-lg border border-border bg-surface p-4"
        aria-label="Session filters"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Repo" htmlFor="repo-filter">
            <Select id="repo-filter" name="repo" defaultValue={repo ?? ''}>
              <option value="">All repos</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Status" htmlFor="status-filter">
            <Select id="status-filter" name="status" defaultValue={status ?? ''}>
              <option value="">All statuses</option>
              {SESSION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Shape" htmlFor="shape-filter">
            <Select id="shape-filter" name="shape" defaultValue={shape ?? ''}>
              <option value="">All shapes</option>
              {shapeLabels.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Friction" htmlFor="band-filter">
            <Select id="band-filter" name="band" defaultValue={frictionBand ?? ''}>
              <option value="">Any</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </Select>
          </Field>

          <Field label="Mode" htmlFor="mode-filter">
            <Select id="mode-filter" name="mode" defaultValue={mode ?? ''}>
              <option value="">All modes</option>
              {PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>

          {agentTypes.length > 1 && (
            <Field label="Agent" htmlFor="agent-filter">
              <Select id="agent-filter" name="agent" defaultValue={agent ?? ''}>
                <option value="">All agents</option>
                {agentTypes.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="From" htmlFor="from-filter">
            <Input id="from-filter" type="date" name="from" defaultValue={params.from ?? ''} />
          </Field>

          <Field label="To" htmlFor="to-filter">
            <Input id="to-filter" type="date" name="to" defaultValue={params.to ?? ''} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button type="submit">Filter</Button>

          {(repo ||
            status ||
            params.from ||
            params.to ||
            shape ||
            agent ||
            frictionBand ||
            mode) && (
            <ButtonLink variant="secondary" href="/me/sessions">
              Clear
            </ButtonLink>
          )}

          <ButtonLink
            className="ml-auto"
            variant="secondary"
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
          >
            Export CSV
          </ButtonLink>
        </div>
      </form>

      <SessionsTable
        sessions={sessions}
        total={total}
        currentPage={page}
        jiraBase={getJiraBase()}
      />
    </div>
  );
}
