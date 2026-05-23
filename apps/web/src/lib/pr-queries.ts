import type { PrismaClient } from '@ai-agents-observability/db';

type PrDb = Pick<PrismaClient, 'pullRequest' | 'pRRollup' | 'session'>;

export type PRListItem = {
  prNumber: number;
  repoOwner: string;
  repoName: string;
  title: string | null;
  state: string;
  openedAt: Date | null;
  mergedAt: Date | null;
  sessionCount: number;
  contributorCount: number;
  totalCostUsd: number;
};

export type PRDetail = PRListItem & {
  baseBranch: string | null;
  headBranch: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
  totalInputTokens: bigint | null;
  totalOutputTokens: bigint | null;
  totalToolCalls: number | null;
  totalActiveSeconds: number | null;
  contributingSessionIds: string[];
  firstSessionAt: Date | null;
  lastSessionAt: Date | null;
};

export async function getUserPRs(
  db: PrDb,
  userId: string,
  page = 1,
  state?: 'open' | 'merged' | 'all',
): Promise<{ items: PRListItem[]; total: number }> {
  const PAGE_SIZE = 25;

  // Find PRs linked to this user's sessions (covers both rolled-up and open PRs)
  const linkedPRs = await db.pullRequest.findMany({
    where: {
      prLinks: { some: { session: { userId } } },
      ...(state === 'open' ? { state: 'open' } : state === 'merged' ? { state: 'merged' } : {}),
    },
    include: { repo: true, rollup: true },
    orderBy: [{ mergedAt: 'desc' }, { openedAt: 'desc' }],
  });

  // Deduplicate by (repoId, prNumber)
  const seen = new Set<string>();
  const merged: PRListItem[] = [];

  for (const pr of linkedPRs) {
    const key = `${pr.repoId}:${pr.prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rollup = pr.rollup;
    merged.push({
      prNumber: pr.prNumber,
      repoOwner: pr.repo.githubOwner,
      repoName: pr.repo.githubName,
      title: pr.title,
      state: pr.state,
      openedAt: pr.openedAt,
      mergedAt: pr.mergedAt,
      sessionCount: rollup?.contributingSessionIds.length ?? 0,
      contributorCount: rollup?.contributingUserIds.length ?? 0,
      totalCostUsd: Number(rollup?.totalCostUsd ?? 0),
    });
  }

  const total = merged.length;
  const items = merged.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return { items, total };
}

export async function getPRDetail(
  db: PrDb,
  userId: string,
  repoOwner: string,
  repoName: string,
  prNumber: number,
): Promise<PRDetail | null> {
  const pr = await db.pullRequest.findFirst({
    where: {
      repo: { githubOwner: repoOwner, githubName: repoName },
      prNumber,
      prLinks: { some: { session: { userId } } },
    },
    include: { repo: true, rollup: true },
  });

  if (!pr) return null;

  return {
    prNumber: pr.prNumber,
    repoOwner: pr.repo.githubOwner,
    repoName: pr.repo.githubName,
    title: pr.title,
    state: pr.state,
    openedAt: pr.openedAt,
    mergedAt: pr.mergedAt,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    linesAdded: pr.linesAdded,
    linesRemoved: pr.linesRemoved,
    filesChanged: pr.filesChanged,
    sessionCount: pr.rollup?.contributingSessionIds.length ?? 0,
    contributorCount: pr.rollup?.contributingUserIds.length ?? 0,
    totalCostUsd: Number(pr.rollup?.totalCostUsd ?? 0),
    totalInputTokens: pr.rollup?.totalInputTokens ?? null,
    totalOutputTokens: pr.rollup?.totalOutputTokens ?? null,
    totalToolCalls: pr.rollup?.totalToolCalls ?? null,
    totalActiveSeconds: pr.rollup?.totalActiveSeconds ?? null,
    contributingSessionIds: pr.rollup?.contributingSessionIds ?? [],
    firstSessionAt: pr.rollup?.firstSessionAt ?? null,
    lastSessionAt: pr.rollup?.lastSessionAt ?? null,
  };
}
