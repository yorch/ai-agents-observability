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
  costPerLoc: number | null;
  revertedAt: Date | null;
  checkFailuresCount: number;
  jiraKey: string | null;
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
    include: { repo: true, rollup: true },
    orderBy: [{ mergedAt: 'desc' }, { openedAt: 'desc' }],
    where: {
      prLinks: { some: { session: { userId } } },
      ...(state === 'open' ? { state: 'OPEN' } : state === 'merged' ? { state: 'MERGED' } : {}),
    },
  });

  // Deduplicate by (repoId, prNumber)
  const seen = new Set<string>();
  const merged: PRListItem[] = [];

  for (const pr of linkedPRs) {
    const key = `${pr.repoId}:${pr.prNumber}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const rollup = pr.rollup;
    merged.push({
      checkFailuresCount: rollup?.checkFailuresCount ?? 0,
      contributorCount: rollup?.contributingUserIds.length ?? 0,
      costPerLoc: rollup?.costPerLoc != null ? Number(rollup.costPerLoc) : null,
      jiraKey: pr.jiraKey,
      mergedAt: pr.mergedAt,
      openedAt: pr.openedAt,
      prNumber: pr.prNumber,
      repoName: pr.repo.githubName,
      repoOwner: pr.repo.githubOwner,
      revertedAt: pr.revertedAt,
      sessionCount: rollup?.contributingSessionIds.length ?? 0,
      state: pr.state,
      title: pr.title,
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
    include: { repo: true, rollup: true },
    where: {
      prLinks: { some: { session: { userId } } },
      prNumber,
      repo: { githubName: repoName, githubOwner: repoOwner },
    },
  });

  if (!pr) {
    return null;
  }

  return {
    baseBranch: pr.baseBranch,
    checkFailuresCount: pr.rollup?.checkFailuresCount ?? 0,
    contributingSessionIds: pr.rollup?.contributingSessionIds ?? [],
    contributorCount: pr.rollup?.contributingUserIds.length ?? 0,
    costPerLoc: pr.rollup?.costPerLoc != null ? Number(pr.rollup.costPerLoc) : null,
    filesChanged: pr.filesChanged,
    firstSessionAt: pr.rollup?.firstSessionAt ?? null,
    headBranch: pr.headBranch,
    jiraKey: pr.jiraKey,
    lastSessionAt: pr.rollup?.lastSessionAt ?? null,
    linesAdded: pr.linesAdded,
    linesRemoved: pr.linesRemoved,
    mergedAt: pr.mergedAt,
    openedAt: pr.openedAt,
    prNumber: pr.prNumber,
    repoName: pr.repo.githubName,
    repoOwner: pr.repo.githubOwner,
    revertedAt: pr.revertedAt,
    sessionCount: pr.rollup?.contributingSessionIds.length ?? 0,
    state: pr.state,
    title: pr.title,
    totalActiveSeconds: pr.rollup?.totalActiveSeconds ?? null,
    totalCostUsd: Number(pr.rollup?.totalCostUsd ?? 0),
    totalInputTokens: pr.rollup?.totalInputTokens ?? null,
    totalOutputTokens: pr.rollup?.totalOutputTokens ?? null,
    totalToolCalls: pr.rollup?.totalToolCalls ?? null,
  };
}
