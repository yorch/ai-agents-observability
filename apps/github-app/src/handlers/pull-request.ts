import { computePRRollup } from '@ai-agents-observability/db';
import {
  createGitHubClient,
  listPRCommitShas,
  parseRepoFullName,
  resolveApiBase,
} from '@ai-agents-observability/github';
import type { RepoConfig } from '@ai-agents-observability/schemas';
import { parseRepoConfig } from '@ai-agents-observability/schemas';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { Logger } from 'pino';
import type { Config } from '../config';
import { backfillPRLinks } from '../lib/backfill-pr-links';
import { getInstallationToken } from '../lib/installation-token';
import { buildCommentBody, postPRComment } from '../lib/pr-comment';
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
    const { repoId, prNumber } = await upsertPullRequest(
      db,
      repo,
      pr as Parameters<typeof upsertPullRequest>[2],
      'OPEN',
    );

    // Link sessions while the PR is still open (branch-name match only — cheap,
    // no API call) so open-PR dashboards see links before merge-time reconcile.
    const linked = await backfillPRLinks(
      db,
      repoId,
      prNumber,
      pr.head.ref,
      pr.created_at ? new Date(pr.created_at) : null,
      { lookbackDays: config.pr_link_lookback_days },
    );
    if (linked > 0) {
      logger.info({ linked, pr: prNumber, repo: repo.full_name }, 'pr.backfill.open');
    }
    return;
  }

  if (action === 'closed') {
    const state = pr.merged ? 'MERGED' : 'CLOSED';
    const { repoId, prNumber } = await upsertPullRequest(
      db,
      repo,
      pr as Parameters<typeof upsertPullRequest>[2],
      state,
    );

    if (pr.merged) {
      // Resolve owner/name and the installation token once — both the
      // commit-SHA fetch and the PR comment need them.
      const parsed = parseRepoFullName(repo.full_name);
      if (!parsed) {
        logger.warn({ full_name: repo.full_name, pr: prNumber }, 'pr.bad_repo_name');
      }
      let installToken: string | null = null;
      if (installationId && parsed) {
        try {
          const privateKeyPem = Buffer.from(config.github_app_private_key_b64, 'base64').toString(
            'utf-8',
          );
          installToken = await getInstallationToken(
            installationId,
            config.github_app_id,
            privateKeyPem,
            config.github_host,
          );
        } catch (err) {
          logger.warn({ err, pr: prNumber }, 'pr.install_token_failed');
        }
      }

      // At merge, also match sessions by commit SHA — catches rebased/renamed
      // branches and squash merges that the branch-name match misses.
      let commitShas: string[] = [];
      if (installToken && parsed) {
        const client = createGitHubClient({ host: config.github_host, token: installToken });
        commitShas = await listPRCommitShas(client, parsed.owner, parsed.name, prNumber);
      }

      const linked = await backfillPRLinks(
        db,
        repoId,
        prNumber,
        pr.head.ref,
        pr.created_at ? new Date(pr.created_at) : null,
        { commitShas, lookbackDays: config.pr_link_lookback_days },
      );
      logger.info({ linked, pr: prNumber, repo: repo.full_name }, 'pr.backfill');

      const rollupResult = await computePRRollup(db, repoId, prNumber);
      logger.info({ ...rollupResult, pr: prNumber }, 'pr.rollup');

      // P5-003: Revert detection — GitHub auto-generates revert PRs with title
      // "Revert "<original title>"" and body "Reverts #<original PR number>".
      const bodyMatch =
        /^Revert\s+["""]/i.test(pr.title ?? '') &&
        /Reverts\s+#(\d+)/.exec((pr as { body?: string | null }).body ?? '');

      if (bodyMatch) {
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

      if (installToken && parsed) {
        try {
          await maybePostComment(db, config, logger, repoId, prNumber, pr, parsed, installToken);
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
  // Pre-validated by parseRepoFullName in the caller; URL-encoded below before
  // interpolating into the fetch URL (defense-in-depth against path injection,
  // even though the payload is signed).
  { name, owner }: { name: string; owner: string },
  installToken: string,
): Promise<void> {
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

  // Distinct agents that contributed to this PR — drives the comment header
  // label (single claude_code is left unlabelled by multiAgentLabels).
  const agentRows = rollup.contributingSessionIds.length
    ? await db.session.findMany({
        distinct: ['agentType'],
        select: { agentType: true },
        where: { sessionId: { in: rollup.contributingSessionIds } },
      })
    : [];
  const agentTypes = agentRows.map((r) => r.agentType as string);

  const body = buildCommentBody(rollup, repoConfig, agentTypes);
  const posted = await postPRComment(owner, name, prNumber, body, installToken, config.github_host);
  logger.info(
    { posted, pr: prNumber, repo: `${owner}/${name}` },
    posted ? 'pr.comment.posted' : 'pr.comment.skipped_existing',
  );
}
