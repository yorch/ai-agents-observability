import { redirect } from 'next/navigation';
import { currentUser } from '../../../lib/auth';
import { getConfig } from '../../../lib/config';
import type { PRListItem } from '../../../lib/pr-queries';
import { getUserPRs } from '../../../lib/pr-queries';
import { getPrisma } from '../../../lib/prisma';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

type SearchParams = {
  page?: string;
  state?: string;
};

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    closed: 'bg-red-500/20 text-red-400',
    merged: 'bg-purple-500/20 text-purple-400',
    open: 'bg-green-500/20 text-green-400',
  };
  const color = colors[state] ?? 'bg-white/10 text-white/50';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{state}</span>;
}

function formatDate(d: Date | null): string {
  if (!d) {
    return '—';
  }
  return d.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function PRsTable({
  items,
  total,
  currentPage,
  stateFilter,
  jiraBase,
}: {
  items: PRListItem[];
  total: number;
  currentPage: number;
  stateFilter: string;
  jiraBase: string | null;
}) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  const stateParam = stateFilter && stateFilter !== 'all' ? `&state=${stateFilter}` : '';

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-sm font-medium text-white/70">No PRs yet.</p>
        <p className="mt-1 text-sm text-white/40">
          PRs appear here after the GitHub App is installed and you merge a PR.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-white/40 text-xs">
              <th className="text-left px-4 py-3">PR</th>
              <th className="text-left px-4 py-3">Repo</th>
              <th className="text-center px-4 py-3">State</th>
              <th className="text-right px-4 py-3">Merged</th>
              <th className="text-right px-4 py-3">Sessions</th>
              <th className="text-right px-4 py-3">Cost</th>
              <th className="text-right px-4 py-3">Checks</th>
              <th className="text-right px-4 py-3">Jira</th>
            </tr>
          </thead>
          <tbody>
            {items.map((pr) => {
              const detailHref = `/me/prs/${encodeURIComponent(`${pr.repoOwner}/${pr.repoName}`)}/${pr.prNumber}`;
              const githubHref = `https://github.com/${pr.repoOwner}/${pr.repoName}/pull/${pr.prNumber}`;
              return (
                <tr
                  key={`${pr.repoOwner}/${pr.repoName}#${pr.prNumber}`}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="px-4 py-3 max-w-[300px]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <a href={detailHref} className="text-white/80 hover:text-white line-clamp-1">
                        {pr.title ?? `#${pr.prNumber}`}
                      </a>
                      {pr.revertedAt && (
                        <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400 shrink-0">
                          reverted
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-white/30 mt-0.5">
                      <a
                        href={githubHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-white/60"
                      >
                        #{pr.prNumber} ↗
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-white/60 text-xs">
                    {pr.repoOwner}/{pr.repoName}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StateBadge state={pr.state} />
                  </td>
                  <td className="px-4 py-3 text-right text-white/50 text-xs">
                    {formatDate(pr.mergedAt)}
                  </td>
                  <td className="px-4 py-3 text-right text-white/60">{pr.sessionCount}</td>
                  <td className="px-4 py-3 text-right text-white/60">
                    ${pr.totalCostUsd.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {pr.checkFailuresCount > 0 ? (
                      <span className="text-amber-400 text-xs font-medium">
                        ⚠ {pr.checkFailuresCount}
                      </span>
                    ) : (
                      <span className="text-white/20 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs">
                    {pr.jiraKey ? (
                      <a
                        href={jiraBase ? `${jiraBase}/browse/${pr.jiraKey}` : undefined}
                        target={jiraBase ? '_blank' : undefined}
                        rel={jiraBase ? 'noopener noreferrer' : undefined}
                        className={jiraBase ? 'text-blue-400 hover:text-blue-300' : 'text-white/50'}
                      >
                        {pr.jiraKey}
                      </a>
                    ) : (
                      <span className="text-white/20">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-white/40">
            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, total)} of{' '}
            {total}
          </p>
          <div className="flex gap-2">
            {hasPrev && (
              <a
                href={`?page=${currentPage - 1}${stateParam}`}
                className="rounded-md border border-white/10 px-3 py-1.5 hover:bg-white/10 transition-colors"
              >
                ← Prev
              </a>
            )}
            {hasNext && (
              <a
                href={`?page=${currentPage + 1}${stateParam}`}
                className="rounded-md border border-white/10 px-3 py-1.5 hover:bg-white/10 transition-colors"
              >
                Next →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default async function PRsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? '1', 10));
  const stateParam = params.state;
  const stateFilter: 'open' | 'merged' | 'all' =
    stateParam === 'open' || stateParam === 'merged' ? stateParam : 'all';

  const jiraBase = getConfig().jiraBaseUrl?.replace(/\/$/, '') ?? null;

  const db = getPrisma();
  const { items, total } = await getUserPRs(db, user.id, page, stateFilter);

  // Summary stats
  const totalCost = items.reduce((sum, pr) => sum + pr.totalCostUsd, 0);
  const totalSessions = items.reduce((sum, pr) => sum + pr.sessionCount, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Pull Requests</h1>

      {/* Summary stats */}
      {total > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <div className="text-xs text-white/40 uppercase tracking-wide">Total PRs</div>
            <div className="mt-1 text-2xl font-semibold">{total}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <div className="text-xs text-white/40 uppercase tracking-wide">Total Cost</div>
            <div className="mt-1 text-2xl font-semibold">${totalCost.toFixed(2)}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <div className="text-xs text-white/40 uppercase tracking-wide">Total Sessions</div>
            <div className="mt-1 text-2xl font-semibold">{totalSessions}</div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <form method="GET" className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="state-filter" className="text-xs text-white/50">
            State
          </label>
          <select
            id="state-filter"
            name="state"
            defaultValue={stateFilter}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="all">All states</option>
            <option value="open">Open</option>
            <option value="merged">Merged</option>
          </select>
        </div>

        <button
          type="submit"
          className="rounded-md bg-brand-500 px-4 py-1.5 text-sm font-medium hover:bg-brand-600 transition-colors"
        >
          Filter
        </button>

        {stateFilter !== 'all' && (
          <a
            href="/me/prs"
            className="rounded-md border border-white/10 px-4 py-1.5 text-sm hover:bg-white/10 transition-colors"
          >
            Clear
          </a>
        )}
      </form>

      <PRsTable
        items={items}
        total={total}
        currentPage={page}
        stateFilter={stateFilter}
        jiraBase={jiraBase}
      />
    </div>
  );
}
