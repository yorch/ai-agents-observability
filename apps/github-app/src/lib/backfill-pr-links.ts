import type { PrismaClient } from '@ai-agents-observability/db';

type BackfillDb = Pick<PrismaClient, 'session' | 'sessionPRLink' | 'pullRequest'>;

type SessionIdRow = { sessionId: string };

export async function backfillPRLinks(
  db: BackfillDb,
  repoId: string,
  prNumber: number,
  headBranch: string,
  prOpenedAt: Date | null,
): Promise<number> {
  // Window: sessions on this branch starting up to 7 days before the PR opened
  const windowStart = prOpenedAt
    ? new Date(prOpenedAt.getTime() - 7 * 24 * 60 * 60 * 1000)
    : new Date(0);

  const sessions = (await db.session.findMany({
    where: {
      repoId,
      gitBranch: headBranch,
      startedAt: { gte: windowStart },
      prLinks: { none: { repoId, prNumber } },
    },
    select: { sessionId: true },
  })) as SessionIdRow[];

  if (sessions.length === 0) return 0;

  await db.sessionPRLink.createMany({
    data: sessions.map((s) => ({
      sessionId: s.sessionId,
      repoId,
      prNumber,
      linkSource: 'webhook_reconcile',
    })),
    skipDuplicates: true,
  });

  return sessions.length;
}
