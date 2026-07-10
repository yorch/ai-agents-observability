import { parseRepoFullName } from '@ai-agents-observability/github';
import type { Logger } from 'pino';
import type { AppDb } from '../types';

// The check_run payload shape we consume — kept structural (not the full
// octokit type) because webhooks.ts parses the body as a plain object.
export type CheckRunPayload = {
  action?: string;
  check_run?: {
    completed_at: string | null;
    conclusion: string | null;
    head_sha?: string;
    id: number;
    name: string;
    pull_requests: Array<{ number: number }>;
    started_at: string | null;
    status: string;
  };
  repository?: { full_name?: string };
};

const FAILING_CONCLUSIONS = ['failure', 'action_required'];

/**
 * check_run webhook → per-run outcome rows in pr_check_runs (created/updated in
 * place across queued→in_progress→completed deliveries). The P5-005
 * check_failures_count on pr_rollups is derived from those rows — a count of
 * failing runs, recomputed whenever a run lands with a conclusion — so
 * redeliveries can never drift the counter. Rows are only written for PRs we
 * already track — the FK to pull_requests is intentional.
 */
export async function handleCheckRun(
  payload: CheckRunPayload,
  db: AppDb,
  logger: Logger,
): Promise<void> {
  const checkRun = payload.check_run;
  const repoFullName = payload.repository?.full_name;
  if (!checkRun || !repoFullName) {
    return;
  }

  const parsed = parseRepoFullName(repoFullName);
  if (!parsed) {
    logger.warn({ repoFullName }, 'check_run: unexpected repository full_name format');
    return;
  }

  const prNumbers = (checkRun.pull_requests ?? []).map((pr) => pr.number);
  if (prNumbers.length === 0) {
    return;
  }

  // Resolve repo once — all PRs in this check_run belong to the same repo.
  const repo = await db.repo.findFirst({
    select: { id: true },
    where: { githubName: parsed.name, githubOwner: parsed.owner },
  });
  if (!repo) {
    return;
  }

  const tracked = await db.pullRequest.findMany({
    select: { prNumber: true },
    where: { prNumber: { in: prNumbers }, repoId: repo.id },
  });

  for (const { prNumber } of tracked) {
    await db.pRCheckRun.upsert({
      create: {
        completedAt: checkRun.completed_at ? new Date(checkRun.completed_at) : null,
        conclusion: checkRun.conclusion,
        githubId: BigInt(checkRun.id),
        headSha: checkRun.head_sha ?? null,
        name: checkRun.name,
        prNumber,
        repoId: repo.id,
        startedAt: checkRun.started_at ? new Date(checkRun.started_at) : null,
        status: checkRun.status,
      },
      update: {
        completedAt: checkRun.completed_at ? new Date(checkRun.completed_at) : null,
        conclusion: checkRun.conclusion,
        status: checkRun.status,
      },
      where: {
        repoId_prNumber_githubId: {
          githubId: BigInt(checkRun.id),
          prNumber,
          repoId: repo.id,
        },
      },
    });

    // Recompute (not increment) once a conclusion exists, so the counter always
    // equals the number of failing runs regardless of redeliveries.
    if (checkRun.conclusion !== null) {
      const failures = await db.pRCheckRun.count({
        where: { conclusion: { in: FAILING_CONCLUSIONS }, prNumber, repoId: repo.id },
      });
      await db.pRRollup.updateMany({
        data: { checkFailuresCount: failures },
        where: { prNumber, repoId: repo.id },
      });
    }
  }
}
