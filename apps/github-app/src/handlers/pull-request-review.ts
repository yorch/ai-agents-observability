import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { Logger } from 'pino';
import { upsertPullRequest } from '../lib/pr-upsert';
import type { AppDb } from '../types';

type PullRequestReviewEvent = EmitterWebhookEvent<'pull_request_review'>['payload'];

/**
 * pull_request_review webhook → pr_reviews rows (review latency / burden
 * signals) + a maintained pull_requests.review_count. The PR row is upserted
 * from the payload first, so the review's FK target always exists — this also
 * keeps PRs current in installs that receive reviews before a PR sync.
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

  // The review payload's pull_request has no `merged` boolean — derive state
  // from state + merged_at.
  const state = pr.state === 'open' ? 'OPEN' : pr.merged_at ? 'MERGED' : 'CLOSED';
  const { repoId, prNumber } = await upsertPullRequest(
    db,
    repo,
    { ...pr, merged: pr.merged_at != null } as Parameters<typeof upsertPullRequest>[2],
    state,
  );

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
