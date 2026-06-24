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
    select: { prNumber: true },
    where: { repoId_prNumber: { prNumber, repoId } },
  });
  if (!pr) {
    return;
  }

  await db.sessionPRLink.upsert({
    create: { linkSource: 'SESSION_START', prNumber, repoId, sessionId },
    update: {},
    where: { sessionId_repoId_prNumber: { prNumber, repoId, sessionId } },
  });
}
