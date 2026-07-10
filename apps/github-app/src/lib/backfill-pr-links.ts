import type { PrismaClient } from '@ai-agents-observability/db';

type BackfillDb = Pick<PrismaClient, 'session' | 'sessionPRLink' | 'pullRequest'>;

type SessionIdRow = { sessionId: string };

export type BackfillOptions = {
  // Sessions starting up to this many days before the PR opened are candidates.
  lookbackDays?: number;
  // Commit SHAs belonging to the PR. A session whose git_commit is one of these
  // links even when its branch name doesn't match head_branch (rebased/renamed
  // branches, squash merges, forks).
  commitShas?: string[];
};

const DEFAULT_LOOKBACK_DAYS = 7;

export async function backfillPRLinks(
  db: BackfillDb,
  repoId: string,
  prNumber: number,
  headBranch: string,
  prOpenedAt: Date | null,
  options: BackfillOptions = {},
): Promise<number> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const commitShas = options.commitShas ?? [];

  // Window: sessions on this branch starting up to `lookbackDays` before the PR opened
  const windowStart = prOpenedAt
    ? new Date(prOpenedAt.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
    : new Date(0);

  // Match on branch name OR on the session's start commit being one of the
  // PR's commits — the SHA path survives branch renames and rebases that the
  // exact-string branch match misses.
  const matchers: object[] = [{ gitBranch: headBranch }];
  if (commitShas.length > 0) {
    matchers.push({ gitCommit: { in: commitShas } });
  }

  const sessions = (await db.session.findMany({
    select: { sessionId: true },
    where: {
      OR: matchers,
      prLinks: { none: { prNumber, repoId } },
      repoId,
      startedAt: { gte: windowStart },
    },
  })) as SessionIdRow[];

  if (sessions.length === 0) {
    return 0;
  }

  await db.sessionPRLink.createMany({
    data: sessions.map((s) => ({
      linkSource: 'WEBHOOK_RECONCILE',
      prNumber,
      repoId,
      sessionId: s.sessionId,
    })),
    skipDuplicates: true,
  });

  return sessions.length;
}
