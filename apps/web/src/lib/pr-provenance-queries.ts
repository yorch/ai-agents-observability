import { getPrisma } from './prisma';

// R10 (HITL): provenance + human-oversight evidence for AI-authored code. Joins
// agent sessions → PRs → reviewers to answer: which merged code was agent-assisted,
// who reviewed it, and was the reviewer someone other than the author (separation
// of duties)? This is the SOC 2 CC8.1 / EU AI Act Art. 14 evidence no general
// LLM-observability tool produces. Visibility-scoped to metadata-sharing users.

export type PrProvenanceRow = {
  authorLogin: string;
  awaitingReview: boolean;
  ciFailures: number;
  mergedAt: Date | null;
  openedAt: Date | null;
  prNumber: number;
  repoName: string;
  repoOwner: string;
  reviewedByOther: boolean;
  reviewerCount: number;
  reverted: boolean;
  sessionCount: number;
  state: string;
  title: string | null;
};

export type PrProvenanceSummary = {
  awaitingReview: number;
  mergedWithoutIndependentReview: number;
  rows: PrProvenanceRow[];
  total: number;
};

export async function getAgentPrProvenance(since: Date, limit = 100): Promise<PrProvenanceSummary> {
  const prs = await getPrisma().pullRequest.findMany({
    include: { _count: { select: { prLinks: true } }, repo: true, rollup: true },
    orderBy: [{ mergedAt: 'desc' }, { openedAt: 'desc' }],
    take: limit,
    where: {
      OR: [{ mergedAt: { gte: since } }, { openedAt: { gte: since } }],
      // Only PRs touched by an agent session from a metadata-sharing user.
      prLinks: {
        some: {
          session: {
            user: {
              deactivatedAt: null,
              OR: [
                { visibilityPolicy: { shareMetadataWithOrg: true } },
                { visibilityPolicy: null },
              ],
            },
          },
        },
      },
    },
  });

  const rows: PrProvenanceRow[] = prs.map((pr) => {
    const author = pr.authorGithubLogin.toLowerCase();
    const reviewers = pr.reviewerLogins ?? [];
    const reviewedByOther = reviewers.some((r) => r.toLowerCase() !== author);
    return {
      authorLogin: pr.authorGithubLogin,
      awaitingReview: pr.state === 'OPEN' && reviewers.length === 0,
      ciFailures: pr.rollup?.checkFailuresCount ?? 0,
      mergedAt: pr.mergedAt,
      openedAt: pr.openedAt,
      prNumber: pr.prNumber,
      repoName: pr.repo.githubName,
      repoOwner: pr.repo.githubOwner,
      reverted: pr.revertedAt != null,
      reviewedByOther,
      reviewerCount: reviewers.length,
      sessionCount: pr._count.prLinks,
      state: pr.state,
      title: pr.title,
    };
  });

  return {
    awaitingReview: rows.filter((r) => r.awaitingReview).length,
    // The oversight gap: merged agent-assisted code with no independent reviewer.
    mergedWithoutIndependentReview: rows.filter((r) => r.state === 'MERGED' && !r.reviewedByOther)
      .length,
    rows,
    total: rows.length,
  };
}
