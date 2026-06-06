import { resolveApiBase } from '@ai-agents-observability/github';
import type { RepoConfig } from '@ai-agents-observability/schemas';
import { parseRepoConfig } from '@ai-agents-observability/schemas';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { Logger } from 'pino';
import type { Config } from '../config';
import { backfillPRLinks } from '../lib/backfill-pr-links';
import { getInstallationToken } from '../lib/installation-token';
import { buildCommentBody, postPRComment } from '../lib/pr-comment';
import { computePRRollup } from '../lib/pr-rollup';
import { upsertPullRequest } from '../lib/pr-upsert';
import type { AppDb } from '../types';

type PullRequestEvent = EmitterWebhookEvent<'pull_request'>['payload'];

export async function handlePullRequest(
  payload: PullRequestEvent,
  db: AppDb,
  config: Config,
  logger: Logger,
): Promise<void> {
  const { action, pull_request: pr, repository: repo } = payload;
  const installationId = (payload as { installation?: { id: number } }).installation?.id ?? null;

  logger.info({ action, pr: pr.number, repo: repo.full_name }, 'pr.webhook');

  if (action === 'opened' || action === 'synchronize') {
    await upsertPullRequest(db, repo, pr as Parameters<typeof upsertPullRequest>[2], 'open');
    return;
  }

  if (action === 'closed') {
    const state = pr.merged ? 'merged' : 'closed';
    const { repoId, prNumber } = await upsertPullRequest(
      db,
      repo,
      pr as Parameters<typeof upsertPullRequest>[2],
      state,
    );

    if (pr.merged) {
      const linked = await backfillPRLinks(
        db,
        repoId,
        prNumber,
        pr.head.ref,
        pr.created_at ? new Date(pr.created_at) : null,
      );
      logger.info({ linked, pr: prNumber, repo: repo.full_name }, 'pr.backfill');

      const rollupResult = await computePRRollup(db, repoId, prNumber);
      logger.info({ ...rollupResult, pr: prNumber }, 'pr.rollup');

      // P5-003: Revert detection — check if this merged PR reverts another PR.
      // GitHub auto-generates revert PRs with title "Revert "<original title>""
      // and body containing "Reverts #<original PR number>".
      const prTitle = pr.title ?? '';
      const prBody = (pr as { body?: string | null }).body ?? '';
      const isRevertTitle = /^Revert\s+["""]/i.test(prTitle);
      const bodyMatch = /Reverts\s+#(\d+)/.exec(prBody);

      if (isRevertTitle && bodyMatch) {
        const originalPrNumber = parseInt(bodyMatch[1] as string, 10);
        const revertedAt = new Date();

        // Both writes are atomic: if one fails the other is rolled back,
        // preventing a half-linked revert pair.
        await db.$transaction([
          db.pullRequest.updateMany({
            data: { revertedAt },
            where: { prNumber: originalPrNumber, repoId },
          }),
          db.pullRequest.update({
            data: { revertOfPrNumber: originalPrNumber },
            where: { repoId_prNumber: { prNumber, repoId } },
          }),
        ]);

        logger.info({ originalPrNumber, prNumber }, 'pr.revert.detected');
      }

      if (installationId) {
        try {
          await maybePostComment(db, config, logger, repoId, prNumber, pr, repo, installationId);
        } catch (err) {
          logger.warn({ err, pr: prNumber }, 'pr.comment.failed');
        }
      }
    }
  }
}

async function maybePostComment(
  db: AppDb,
  config: Config,
  logger: Logger,
  repoId: string,
  prNumber: number,
  pr: PullRequestEvent['pull_request'],
  repo: PullRequestEvent['repository'],
  installationId: number,
): Promise<void> {
  const privateKeyPem = Buffer.from(config.github_app_private_key_b64, 'base64').toString('utf-8');
  const installToken = await getInstallationToken(
    installationId,
    config.github_app_id,
    privateKeyPem,
    config.github_host,
  );

  // full_name should be exactly "owner/name". Validate rather than trust the
  // payload, and URL-encode each segment before interpolating into the fetch URL
  // (defense-in-depth against path injection, even though the payload is signed).
  const parts = repo.full_name.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    logger.warn({ full_name: repo.full_name, pr: prNumber }, 'pr.comment.bad_repo_name');
    return;
  }
  const [owner, name] = parts as [string, string];
  const apiBase = resolveApiBase(config.github_host);

  const mergeCommitSha = (pr as { merge_commit_sha?: string | null }).merge_commit_sha;
  const refParam = mergeCommitSha ? `?ref=${encodeURIComponent(mergeCommitSha)}` : '';

  const configRes = await fetch(
    `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/.claude-telemetry.yml${refParam}`,
    {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        Authorization: `Bearer ${installToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!configRes.ok) {
    return;
  }

  const yamlText = await configRes.text();
  const repoConfig: RepoConfig | null = parseRepoConfig(yamlText);
  if (!repoConfig?.pr_bot.enabled) {
    return;
  }

  const rollup = await db.pRRollup.findUnique({
    where: { repoId_prNumber: { prNumber, repoId } },
  });
  if (!rollup) {
    return;
  }

  const body = buildCommentBody(rollup, repoConfig);
  const posted = await postPRComment(owner, name, prNumber, body, installToken, config.github_host);
  logger.info(
    { posted, pr: prNumber, repo: repo.full_name },
    posted ? 'pr.comment.posted' : 'pr.comment.skipped_existing',
  );
}
