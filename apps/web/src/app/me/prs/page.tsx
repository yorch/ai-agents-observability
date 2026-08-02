import { redirect } from 'next/navigation';
import { PrStateBadge } from '@/components/me/PrStateBadge';
import {
  Button,
  ButtonLink,
  Cell,
  EmptyState,
  Field,
  Pagination,
  Row,
  Select,
  Stat,
  Table,
} from '@/components/ui';
import { fmtDate } from '@/lib/fmt';
import { ExternalLinkIcon, WarningIcon } from '../../../components/icons';
import { JiraLink } from '../../../components/JiraLink';
import { currentUser } from '../../../lib/auth';
import { getJiraBase } from '../../../lib/config';
import type { PRListItem } from '../../../lib/pr-queries';
import { getUserPRs } from '../../../lib/pr-queries';
import { getPrisma } from '../../../lib/prisma';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

type SearchParams = {
  page?: string;
  state?: string;
};

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
  const stateParam = stateFilter && stateFilter !== 'all' ? `&state=${stateFilter}` : '';

  if (items.length === 0) {
    return (
      <EmptyState title="No PRs yet.">
        PRs appear here after the GitHub App is installed and you merge a PR.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <Table
        columns={[
          { label: 'PR' },
          { label: 'Repo' },
          { label: 'State' },
          { align: 'right', label: 'Merged' },
          { align: 'right', label: 'Sessions' },
          { align: 'right', label: 'Cost' },
          { align: 'right', label: 'Cost/LOC' },
          { align: 'right', label: 'Checks' },
          { align: 'right', label: 'Jira' },
        ]}
      >
        {items.map((pr) => {
          const detailHref = `/me/prs/${encodeURIComponent(pr.repoOwner)}/${encodeURIComponent(pr.repoName)}/${pr.prNumber}`;
          const githubHref = `https://github.com/${pr.repoOwner}/${pr.repoName}/pull/${pr.prNumber}`;
          return (
            <Row key={`${pr.repoOwner}/${pr.repoName}#${pr.prNumber}`}>
              <Cell className="max-w-[300px]">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <a href={detailHref} className="text-text hover:text-text line-clamp-1">
                    {pr.title ?? `#${pr.prNumber}`}
                  </a>
                  {pr.revertedAt && (
                    <span className="rounded-full bg-crit-soft px-1.5 py-0.5 text-[10px] font-medium text-crit shrink-0">
                      reverted
                    </span>
                  )}
                </div>
                <div className="text-xs text-text-3 mt-0.5">
                  <a
                    href={githubHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-text-2"
                  >
                    #{pr.prNumber} <ExternalLinkIcon size={11} />
                  </a>
                </div>
              </Cell>
              <Cell className="text-text-2 text-xs">
                {pr.repoOwner}/{pr.repoName}
              </Cell>
              <Cell className="text-center">
                <PrStateBadge state={pr.state} />
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {fmtDate(pr.mergedAt)}
              </Cell>
              <Cell num className="text-text-2">
                {pr.sessionCount}
              </Cell>
              <Cell num className="text-text-2">
                ${pr.totalCostUsd.toFixed(2)}
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {pr.costPerLoc != null ? `$${pr.costPerLoc.toFixed(3)}` : '—'}
              </Cell>
              <Cell num>
                {pr.checkFailuresCount > 0 ? (
                  <span className="inline-flex items-center gap-1 text-warn text-xs font-medium">
                    <WarningIcon size={12} /> {pr.checkFailuresCount}
                  </span>
                ) : (
                  <span className="text-text-3 text-xs">—</span>
                )}
              </Cell>
              <Cell num className="text-xs">
                {pr.jiraKey ? (
                  <JiraLink jiraBase={jiraBase} jiraKey={pr.jiraKey} plainClassName="text-text-2" />
                ) : (
                  <span className="text-text-3">—</span>
                )}
              </Cell>
            </Row>
          );
        })}
      </Table>

      <Pagination
        page={currentPage}
        pageSize={PAGE_SIZE}
        total={total}
        hrefFor={(n) => `?page=${n}${stateParam}`}
      />
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

  const jiraBase = getJiraBase();

  const db = getPrisma();
  const { items, total } = await getUserPRs(db, user.id, page, stateFilter);

  // Summary stats
  const totalCost = items.reduce((sum, pr) => sum + pr.totalCostUsd, 0);
  const totalSessions = items.reduce((sum, pr) => sum + pr.sessionCount, 0);

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
        Pull Requests
      </h1>

      {/* Summary stats */}
      {total > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Total PRs" value={String(total)} />
          <Stat label="Total cost" value={`$${totalCost.toFixed(2)}`} />
          <Stat label="Total sessions" value={String(totalSessions)} />
        </div>
      )}

      {/* Filter bar */}
      <form method="GET" className="flex flex-wrap items-end gap-3">
        <Field label="State" htmlFor="state-filter">
          <Select id="state-filter" name="state" defaultValue={stateFilter}>
            <option value="all">All states</option>
            <option value="open">Open</option>
            <option value="merged">Merged</option>
          </Select>
        </Field>

        <Button type="submit">Filter</Button>

        {stateFilter !== 'all' && (
          <ButtonLink variant="secondary" href="/me/prs">
            Clear
          </ButtonLink>
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
