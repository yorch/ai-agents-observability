import type { PrismaClient } from '@ai-agents-observability/db';

type LinkDb = Pick<PrismaClient, 'sessionPRLink' | 'pullRequest'>;

// Best-effort: links a session to a PR if the PR row already exists.
// Silently skips if the PR row doesn't exist yet (backfill covers it at close time).
export async function linkSessionToPR(
  db: LinkDb,
  sessionId: string,
  repoId: string,
  prNumber: number,
): Promise<void> {
  const pr = await db.pullRequest.findUnique({
    where: { repoId_prNumber: { repoId, prNumber } },
    select: { prNumber: true },
  });
  if (!pr) return;

  await db.sessionPRLink.upsert({
    where: { sessionId_repoId_prNumber: { sessionId, repoId, prNumber } },
    create: { sessionId, repoId, prNumber, linkSource: 'session_start' },
    update: {},
  });
}
