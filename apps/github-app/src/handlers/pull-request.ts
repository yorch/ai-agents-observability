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

  const [owner, name] = repo.full_name.split('/') as [string, string];
  const apiBase =
    config.github_host === 'https://github.com'
      ? 'https://api.github.com'
      : `${config.github_host}/api/v3`;

  const mergeCommitSha = (pr as { merge_commit_sha?: string | null }).merge_commit_sha;
  const refParam = mergeCommitSha ? `?ref=${mergeCommitSha}` : '';

  const configRes = await fetch(
    `${apiBase}/repos/${owner}/${name}/contents/.claude-telemetry.yml${refParam}`,
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
  await postPRComment(owner, name, prNumber, body, installToken, config.github_host);
  logger.info({ pr: prNumber, repo: repo.full_name }, 'pr.comment.posted');
}
