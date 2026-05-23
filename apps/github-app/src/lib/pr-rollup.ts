import type { PrismaClient } from '@ai-agents-observability/db';

type RollupDb = Pick<PrismaClient, 'sessionPRLink' | 'session' | 'pRRollup' | 'pullRequest'>;

export type RollupResult = {
  contributorCount: number;
  sessionCount: number;
  totalCostUsd: number;
};

export async function computePRRollup(
  db: RollupDb,
  repoId: string,
  prNumber: number,
): Promise<RollupResult> {
  const links = await db.sessionPRLink.findMany({ where: { repoId, prNumber } });
  const sessionIds = links.map((l) => l.sessionId);

  const sessions =
    sessionIds.length > 0
      ? await db.session.findMany({ where: { sessionId: { in: sessionIds } } })
      : [];

  const contributorIds = [...new Set(sessions.map((s) => s.userId))];
  const totalCostUsd = sessions.reduce((sum, s) => sum + Number(s.totalCostUsd), 0);
  const totalInputTokens = sessions.reduce((sum, s) => sum + Number(s.totalInputTokens), 0);
  const totalOutputTokens = sessions.reduce((sum, s) => sum + Number(s.totalOutputTokens), 0);
  const totalToolCalls = sessions.reduce((sum, s) => sum + s.toolCallCount, 0);
  const totalToolErrors = sessions.reduce((sum, s) => sum + s.toolErrorCount, 0);
  const totalPermissionDenies = sessions.reduce((sum, s) => sum + s.permissionDenyCount, 0);

  const endedSessions = sessions.filter((s) => s.endedAt !== null);
  const totalActiveSeconds =
    endedSessions.length > 0
      ? endedSessions.reduce((sum, s) => {
          const secs = (s.endedAt!.getTime() - s.startedAt.getTime()) / 1000;
          return sum + secs;
        }, 0)
      : null;

  const startedAts = sessions.map((s) => s.startedAt).sort((a, b) => a.getTime() - b.getTime());
  const firstSessionAt = startedAts[0] ?? null;
  const lastSessionAt = startedAts[startedAts.length - 1] ?? null;

  const pr = await db.pullRequest.findUnique({
    where: { repoId_prNumber: { repoId, prNumber } },
  });
  const loc = pr ? (pr.linesAdded ?? 0) + (pr.linesRemoved ?? 0) : 0;
  const costPerLoc = loc > 0 ? totalCostUsd / loc : null;

  await db.pRRollup.upsert({
    where: { repoId_prNumber: { repoId, prNumber } },
    create: {
      repoId,
      prNumber,
      contributingUserIds: contributorIds,
      contributingSessionIds: sessionIds,
      firstSessionAt,
      lastSessionAt,
      totalActiveSeconds: totalActiveSeconds !== null ? Math.round(totalActiveSeconds) : null,
      totalCostUsd,
      totalInputTokens: BigInt(totalInputTokens),
      totalOutputTokens: BigInt(totalOutputTokens),
      totalToolCalls,
      totalToolErrors,
      totalPermissionDenies,
      costPerLoc,
    },
    update: {
      contributingUserIds: contributorIds,
      contributingSessionIds: sessionIds,
      firstSessionAt,
      lastSessionAt,
      totalActiveSeconds: totalActiveSeconds !== null ? Math.round(totalActiveSeconds) : null,
      totalCostUsd,
      totalInputTokens: BigInt(totalInputTokens),
      totalOutputTokens: BigInt(totalOutputTokens),
      totalToolCalls,
      totalToolErrors,
      totalPermissionDenies,
      costPerLoc,
      computedAt: new Date(),
    },
  });

  return { contributorCount: contributorIds.length, sessionCount: sessions.length, totalCostUsd };
}
