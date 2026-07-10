import { parseRepoFullName } from '@ai-agents-observability/github';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { Logger } from 'pino';
import { upsertPullRequest } from '../lib/pr-upsert';
import type { AppDb } from '../types';

type PullRequestReviewEvent = EmitterWebhookEvent<'pull_request_review'>['payload'];

/**
 * pull_request_review webhook → pr_reviews rows (review latency / burden
 * signals) + a maintained pull_requests.review_count. When the PR isn't
 * tracked yet it is created from the payload; already-tracked PRs are left
 * untouched — the review payload's abbreviated PR object lacks diff stats,
 * so writing it through the full upsert would erase them.
 */
export async function handlePullRequestReview(
  payload: PullRequestReviewEvent,
  db: AppDb,
  logger: Logger,
): Promise<void> {
  const { action, pull_request: pr, repository: repo, review } = payload;

  logger.info({ action, pr: pr.number, repo: repo.full_name }, 'pr_review.webhook');

  if (action !== 'submitted' && action !== 'edited' && action !== 'dismissed') {
    return;
  }

  const parsed = parseRepoFullName(repo.full_name);
  if (!parsed) {
    logger.warn({ repoFullName: repo.full_name }, 'pr_review: unexpected repository full_name');
    return;
  }

  const repoRow = await db.repo.findFirst({
    select: { id: true },
    where: { githubName: parsed.name, githubOwner: parsed.owner },
  });
  const existing = repoRow
    ? await db.pullRequest.findUnique({
        select: { prNumber: true },
        where: { repoId_prNumber: { prNumber: pr.number, repoId: repoRow.id } },
      })
    : null;

  let repoId: string;
  const prNumber = pr.number;
  if (repoRow && existing) {
    repoId = repoRow.id;
  } else {
    // First time we see this PR — create it from the payload. The abbreviated
    // PR object has no `merged` boolean; derive state from state + merged_at.
    const state = pr.state === 'open' ? 'OPEN' : pr.merged_at ? 'MERGED' : 'CLOSED';
    const created = await upsertPullRequest(
      db,
      repo,
      { ...pr, merged: pr.merged_at != null } as Parameters<typeof upsertPullRequest>[2],
      state,
    );
    repoId = created.repoId;
  }

  const reviewState = action === 'dismissed' ? 'DISMISSED' : review.state.toUpperCase();

  await db.pRReview.upsert({
    create: {
      githubId: BigInt(review.id),
      prNumber,
      repoId,
      reviewerLogin: review.user?.login ?? 'ghost',
      state: reviewState,
      submittedAt: review.submitted_at ? new Date(review.submitted_at) : null,
    },
    update: {
      state: reviewState,
    },
    where: { githubId: BigInt(review.id) },
  });

  // review_count previously only reflected requested reviewers at upsert time;
  // maintain it as the count of actually-submitted reviews.
  const reviewCount = await db.pRReview.count({ where: { prNumber, repoId } });
  await db.pullRequest.update({
    data: { reviewCount },
    where: { repoId_prNumber: { prNumber, repoId } },
  });
}
