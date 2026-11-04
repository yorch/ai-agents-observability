import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon } from '@/components/icons';
import { PrStateBadge } from '@/components/me/PrStateBadge';
import { Card, EmptyState, SectionHeader, Stat } from '@/components/ui';
import { currentUser, redirectToLogin } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtDurationSec, fmtUsd, fmtUsdSession } from '@/lib/fmt';
import { getPRDetail } from '@/lib/pr-queries';
import { getPrisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

type PageParams = { pr: string[] };

function formatActiveTime(seconds: number | null): string {
  if (seconds === null || seconds === 0) {
    return '—';
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

type SessionRow = {
  endedAt: Date | null;
  startedAt: Date;
  totalCostUsd: unknown;
};

function sessionLabel(row: SessionRow | undefined, id: string): string {
  if (!row) {
    return id.slice(0, 8);
  }
  return `${fmtDateTime(row.startedAt)} UTC · ${fmtDurationSec(
    row.endedAt ? Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 1000) : null,
  )} · ${fmtUsdSession(Number(row.totalCostUsd))}`;
}

export default async function PRDetailPage({ params }: { params: Promise<PageParams> }) {
  const user = await currentUser();
  if (!user) {
    return redirectToLogin();
  }

  const { pr: segments } = await params;

  // Expect at least 3 segments: owner, repo, prNumber
  // The catch-all may capture more segments for repos with slashes, but typically: [owner, repo, prNum]
  if (!segments || segments.length < 3) {
    notFound();
  }

  const prNumStr = segments[segments.length - 1];
  const repoName = segments[segments.length - 2];
  const repoOwner = segments.slice(0, segments.length - 2).join('/');

  if (!prNumStr || !repoName) {
    notFound();
  }

  const prNumber = parseInt(prNumStr, 10);
  if (Number.isNaN(prNumber)) {
    notFound();
  }

  const db = getPrisma();
  const pr = await getPRDetail(db, user.id, repoOwner, repoName, prNumber);

  if (!pr) {
    notFound();
  }

  // Identify contributing sessions by date/duration/cost rather than UUID. Only
  // the viewer's own sessions resolve; others fall back to the short id.
  const sessionRows =
    pr.contributingSessionIds.length > 0
      ? await db.session.findMany({
          select: { endedAt: true, sessionId: true, startedAt: true, totalCostUsd: true },
          where: { sessionId: { in: pr.contributingSessionIds }, userId: user.id },
        })
      : [];
  const sessionById = new Map(sessionRows.map((r) => [r.sessionId, r]));

  const githubHref = `https://github.com/${pr.repoOwner}/${pr.repoName}/pull/${pr.prNumber}`;
  const hasRollup = pr.contributingSessionIds.length > 0 || pr.totalCostUsd > 0;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/me/prs"
        className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text"
      >
        <ArrowLeftIcon /> Pull requests
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <h1 className="min-w-0 flex-1 font-display text-xl font-semibold tracking-tight text-text">
            {pr.title ?? `PR #${pr.prNumber}`}
          </h1>
          <PrStateBadge state={pr.state} />
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-2">
          <span>
            <a
              href={githubHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-text"
            >
              {pr.repoOwner}/{pr.repoName} #{pr.prNumber} <ExternalLinkIcon size={11} />
            </a>
          </span>
          {pr.headBranch && pr.baseBranch && (
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              {pr.headBranch} <ArrowRightIcon size={11} /> {pr.baseBranch}
            </span>
          )}
          {pr.openedAt && <span>opened: {fmtDate(pr.openedAt)}</span>}
          {pr.mergedAt && <span>merged: {fmtDate(pr.mergedAt)}</span>}
        </div>

        {/* Diff stats */}
        {(pr.linesAdded !== null || pr.linesRemoved !== null || pr.filesChanged !== null) && (
          <div className="flex gap-4 text-xs">
            {pr.filesChanged !== null && (
              <span className="text-text-3">{pr.filesChanged} files changed</span>
            )}
            {pr.linesAdded !== null && <span className="text-good">+{pr.linesAdded}</span>}
            {pr.linesRemoved !== null && <span className="text-crit">-{pr.linesRemoved}</span>}
          </div>
        )}
      </div>

      {/* No rollup state */}
      {!hasRollup && (
        <EmptyState>Rollup computed at merge time. Check back after this PR is merged.</EmptyState>
      )}

      {/* Summary cards */}
      {hasRollup && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Cost" value={fmtUsd(pr.totalCostUsd)} />
          <Stat label="Sessions" value={pr.sessionCount.toLocaleString()} />
          <Stat label="Contributors" value={pr.contributorCount.toLocaleString()} />
          <Stat label="Active time" value={formatActiveTime(pr.totalActiveSeconds)} />
        </div>
      )}

      {/* Token stats */}
      {hasRollup &&
        (pr.totalInputTokens !== null ||
          pr.totalOutputTokens !== null ||
          pr.totalToolCalls !== null) && (
          <Card title="Usage breakdown" contentClassName="space-y-2">
            <div className="grid gap-4 text-sm sm:grid-cols-3">
              {pr.totalInputTokens !== null && (
                <div>
                  <div className="text-xs text-text-3">Input tokens</div>
                  <div className="text-text">{Number(pr.totalInputTokens).toLocaleString()}</div>
                </div>
              )}
              {pr.totalOutputTokens !== null && (
                <div>
                  <div className="text-xs text-text-3">Output tokens</div>
                  <div className="text-text">{Number(pr.totalOutputTokens).toLocaleString()}</div>
                </div>
              )}
              {pr.totalToolCalls !== null && (
                <div>
                  <div className="text-xs text-text-3">Tool calls</div>
                  <div className="text-text">{pr.totalToolCalls.toLocaleString()}</div>
                </div>
              )}
            </div>
            {(pr.firstSessionAt || pr.lastSessionAt) && (
              <div className="pt-2 border-t border-border text-xs text-text-3 flex gap-4">
                {pr.firstSessionAt && <span>first session: {fmtDate(pr.firstSessionAt)}</span>}
                {pr.lastSessionAt && <span>last session: {fmtDate(pr.lastSessionAt)}</span>}
              </div>
            )}
          </Card>
        )}

      {/* Contributing sessions */}
      {pr.contributingSessionIds.length > 0 && (
        <div className="space-y-3">
          <SectionHeader>Contributing sessions ({pr.contributingSessionIds.length})</SectionHeader>
          <div className="rounded-lg border border-border overflow-hidden">
            {pr.contributingSessionIds.map((sessionId) => (
              <div
                key={sessionId}
                className="flex items-center justify-between px-4 py-3 border-b border-border-subtle last:border-0 hover:bg-surface-2 transition-colors"
              >
                <Link
                  href={`/me/sessions/${sessionId}`}
                  className="font-mono text-sm text-text-2 hover:text-text"
                >
                  {sessionLabel(sessionById.get(sessionId), sessionId)}
                </Link>
                <Link
                  href={`/me/sessions/${sessionId}`}
                  className="inline-flex items-center gap-1 text-xs text-text-3 hover:text-text-2"
                >
                  View <ArrowRightIcon />
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
