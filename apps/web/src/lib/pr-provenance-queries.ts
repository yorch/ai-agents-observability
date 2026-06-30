import type { Prisma } from '@ai-agents-observability/db';
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

// An independent review = at least one reviewer who is not the PR author
// (SOC 2 CC8.1 separation of duties).
function hasIndependentReview(authorLogin: string, reviewerLogins: string[]): boolean {
  const author = authorLogin.toLowerCase();
  return reviewerLogins.some((r) => r.toLowerCase() !== author);
}

// Cap on the lightweight scan used for the summary counts. Far above any realistic
// per-window agent-PR volume for a single org; the table itself shows the top
// `limit` rows. Summary counts cover up to this many PRs.
const SUMMARY_SCAN_CAP = 5000;

export async function getAgentPrProvenance(since: Date, limit = 100): Promise<PrProvenanceSummary> {
  const db = getPrisma();
  const where: Prisma.PullRequestWhereInput = {
    OR: [{ mergedAt: { gte: since } }, { openedAt: { gte: since } }],
    // Only PRs touched by an agent session from a metadata-sharing user.
    prLinks: {
      some: {
        session: {
          user: {
            deactivatedAt: null,
            OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
          },
        },
      },
    },
  };

  // Summary counts scan a light projection of ALL matching PRs (not the table's
  // capped page) so the audit figures don't silently undercount. The table fetch
  // pulls the heavier includes for only the top `limit` rows.
  const [summaryRows, prs] = await Promise.all([
    db.pullRequest.findMany({
      select: { authorGithubLogin: true, reviewerLogins: true, state: true },
      take: SUMMARY_SCAN_CAP,
      where,
    }),
    db.pullRequest.findMany({
      include: { _count: { select: { prLinks: true } }, repo: true, rollup: true },
      orderBy: [{ mergedAt: 'desc' }, { openedAt: 'desc' }],
      take: limit,
      where,
    }),
  ]);

  const rows: PrProvenanceRow[] = prs.map((pr) => {
    const reviewers = pr.reviewerLogins;
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
      reviewedByOther: hasIndependentReview(pr.authorGithubLogin, reviewers),
      reviewerCount: reviewers.length,
      sessionCount: pr._count.prLinks,
      state: pr.state,
      title: pr.title,
    };
  });

  return {
    awaitingReview: summaryRows.filter((r) => r.state === 'OPEN' && r.reviewerLogins.length === 0)
      .length,
    // The oversight gap: merged agent-assisted code with no independent reviewer.
    mergedWithoutIndependentReview: summaryRows.filter(
      (r) => r.state === 'MERGED' && !hasIndependentReview(r.authorGithubLogin, r.reviewerLogins),
    ).length,
    rows,
    total: summaryRows.length,
  };
}
