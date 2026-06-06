import { redirect } from 'next/navigation';
import { SessionsTable } from '@/components/me/SessionsTable';
import { currentUser } from '@/lib/auth';
import { listDistinctRepos, listSessions } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

function parseDate(s: string | undefined): Date | undefined {
  if (!s) {
    return undefined;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const SESSION_STATUSES = ['active', 'completed', 'crashed', 'timed_out', 'abandoned'] as const;

type SearchParams = {
  from?: string;
  page?: string;
  repo?: string;
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
  const dateFrom = parseDate(params.from);
  const dateTo = parseDate(params.to);

  const sessionOpts = {
    page,
    ...(repo ? { repo } : {}),
    ...(status ? { status } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };

  const [{ sessions, total }, repos] = await Promise.all([
    listSessions(user.id, sessionOpts),
    listDistinctRepos(user.id),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Sessions</h1>

      {/* Filter bar */}
      <form method="GET" className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="repo-filter" className="text-xs text-white/50">
            Repo
          </label>
          <select
            id="repo-filter"
            name="repo"
            defaultValue={repo ?? ''}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="">All repos</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="status-filter" className="text-xs text-white/50">
            Status
          </label>
          <select
            id="status-filter"
            name="status"
            defaultValue={status ?? ''}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
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
          <label htmlFor="from-filter" className="text-xs text-white/50">
            From
          </label>
          <input
            id="from-filter"
            type="date"
            name="from"
            defaultValue={params.from ?? ''}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="to-filter" className="text-xs text-white/50">
            To
          </label>
          <input
            id="to-filter"
            type="date"
            name="to"
            defaultValue={params.to ?? ''}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>

        <button
          type="submit"
          className="rounded-md bg-brand-500 px-4 py-1.5 text-sm font-medium hover:bg-brand-600 transition-colors"
        >
          Filter
        </button>

        {(repo || status || params.from || params.to) && (
          <a
            href="/me/sessions"
            className="rounded-md border border-white/10 px-4 py-1.5 text-sm hover:bg-white/10 transition-colors"
          >
            Clear
          </a>
        )}
      </form>

      <SessionsTable sessions={sessions} total={total} currentPage={page} />
    </div>
  );
}
