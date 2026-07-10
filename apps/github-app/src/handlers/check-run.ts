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

/**
 * check_run webhook → per-run outcome rows in pr_check_runs (created/updated in
 * place across queued→in_progress→completed deliveries), plus the P5-005
 * failure counter on pr_rollups (incremented once, when a run lands with a
 * failing conclusion). Rows are only written for PRs we already track — the
 * FK to pull_requests is intentional.
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

  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    logger.warn({ repoFullName }, 'check_run: unexpected repository full_name format');
    return;
  }
  const [owner, name] = parts as [string, string];

  // Resolve repo once — all PRs in this check_run belong to the same repo.
  const repo = await db.repo.findFirst({
    select: { id: true },
    where: { githubName: name, githubOwner: owner },
  });
  if (!repo) {
    return;
  }

  const isFailure = checkRun.conclusion === 'failure' || checkRun.conclusion === 'action_required';

  for (const pr of checkRun.pull_requests ?? []) {
    const prRow = await db.pullRequest.findUnique({
      select: { prNumber: true },
      where: { repoId_prNumber: { prNumber: pr.number, repoId: repo.id } },
    });
    if (!prRow) {
      continue;
    }

    await db.pRCheckRun.upsert({
      create: {
        completedAt: checkRun.completed_at ? new Date(checkRun.completed_at) : null,
        conclusion: checkRun.conclusion,
        githubId: BigInt(checkRun.id),
        headSha: checkRun.head_sha ?? null,
        name: checkRun.name,
        prNumber: pr.number,
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
          prNumber: pr.number,
          repoId: repo.id,
        },
      },
    });

    // P5-005 failure counter — same semantics as before this handler existed:
    // increment when a delivery arrives with a failing conclusion.
    if (isFailure) {
      await db.pRRollup.updateMany({
        data: { checkFailuresCount: { increment: 1 } },
        where: { prNumber: pr.number, repoId: repo.id },
      });
    }
  }
}
