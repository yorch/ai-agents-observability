import type { PrismaClient } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

// Full Jira integration (P5-004 follow-up). Env-gated: the job only runs when
// JIRA_BASE_URL and JIRA_API_TOKEN are configured. It resolves every Jira key
// referenced by pull_requests.jira_key / sessions.jira_key into a jira_issues
// row — issue type, status, epic, story points — enabling epic-level cost
// rollups and bug↔PR↔session correlation without any webhook from Jira.

export type JiraSyncConfig = {
  baseUrl: string;
  // Jira Cloud: set email → Basic auth (email:api_token).
  // Jira Server/DC: leave email unset → Bearer auth (personal access token).
  email?: string;
  apiToken: string;
  // Story points live in an instance-specific custom field (e.g. customfield_10016).
  storyPointsField?: string;
};

export type SyncJiraDb = Pick<PrismaClient, 'jiraIssue' | 'jobRun' | 'pullRequest' | 'session'> & {
  $queryRaw: PrismaClient['$queryRaw'];
};

// Re-sync an issue only when its snapshot is older than this. Keys never seen
// before always sync.
const RESYNC_AFTER_MS = 6 * 60 * 60 * 1000;

// Upper bound of API calls per run; the remainder syncs on later runs.
const MAX_ISSUES_PER_RUN = 500;

type JiraIssueFields = {
  assignee?: { displayName?: string; emailAddress?: string; name?: string } | null;
  issuetype?: { name?: string } | null;
  parent?: { key?: string } | null;
  resolutiondate?: string | null;
  status?: { name?: string } | null;
  summary?: string | null;
} & Record<string, unknown>;

function authHeader(config: JiraSyncConfig): string {
  if (config.email) {
    return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  }
  return `Bearer ${config.apiToken}`;
}

async function fetchIssue(
  config: JiraSyncConfig,
  key: string,
): Promise<{ fields: JiraIssueFields } | null> {
  const base = config.baseUrl.replace(/\/$/, '');
  const fields = [
    'summary',
    'issuetype',
    'status',
    'parent',
    'assignee',
    'resolutiondate',
    ...(config.storyPointsField ? [config.storyPointsField] : []),
  ].join(',');

  const res = await fetch(
    `${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: authHeader(config),
      },
    },
  );
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as { fields: JiraIssueFields };
}

export async function runSyncJira(
  db: SyncJiraDb,
  config: JiraSyncConfig,
  logger?: Logger,
): Promise<void> {
  const jobName = 'sync-jira';
  const startedAt = new Date();

  const lockResult = await db.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(hashtext(${`job:${jobName}`}))
  `;
  if (!lockResult[0]?.pg_try_advisory_lock) {
    logger?.warn({ jobName }, 'Advisory lock not acquired, skipping job run');
    return;
  }

  let jobRunId: bigint | undefined;
  try {
    const jobRun = await db.jobRun.create({
      data: { jobName, startedAt, status: 'running' },
    });
    jobRunId = jobRun.id;

    // Every key referenced anywhere (PR-side extraction + session-side extraction).
    const [prKeys, sessionKeys] = await Promise.all([
      db.pullRequest.findMany({
        distinct: ['jiraKey'],
        select: { jiraKey: true },
        where: { jiraKey: { not: null } },
      }),
      db.session.findMany({
        distinct: ['jiraKey'],
        select: { jiraKey: true },
        where: { jiraKey: { not: null } },
      }),
    ]);
    const allKeys = new Set<string>();
    for (const row of [...prKeys, ...sessionKeys]) {
      if (row.jiraKey) {
        allKeys.add(row.jiraKey);
      }
    }

    // Skip keys with a fresh snapshot.
    const freshCutoff = new Date(Date.now() - RESYNC_AFTER_MS);
    const fresh = await db.jiraIssue.findMany({
      select: { key: true },
      where: { key: { in: [...allKeys] }, syncedAt: { gte: freshCutoff } },
    });
    for (const row of fresh) {
      allKeys.delete(row.key);
    }

    const keys = [...allKeys].slice(0, MAX_ISSUES_PER_RUN);
    let synced = 0;
    let missing = 0;

    for (const key of keys) {
      let issue: { fields: JiraIssueFields } | null;
      try {
        issue = await fetchIssue(config, key);
      } catch (err) {
        logger?.warn({ err, key }, 'sync-jira: fetch failed');
        continue;
      }
      if (!issue) {
        // 404 / no permission — the key was extracted from a branch or title
        // and may simply not be a real issue. Count it, don't create a row.
        missing += 1;
        continue;
      }

      const f = issue.fields;
      const storyPointsRaw = config.storyPointsField ? f[config.storyPointsField] : null;
      const storyPoints = typeof storyPointsRaw === 'number' ? storyPointsRaw : null;

      await db.jiraIssue.upsert({
        create: {
          assignee: f.assignee?.displayName ?? f.assignee?.name ?? null,
          epicKey: f.parent?.key ?? null,
          issueType: f.issuetype?.name ?? null,
          key,
          resolvedAt: f.resolutiondate ? new Date(f.resolutiondate) : null,
          status: f.status?.name ?? null,
          storyPoints,
          summary: f.summary ?? null,
        },
        update: {
          assignee: f.assignee?.displayName ?? f.assignee?.name ?? null,
          epicKey: f.parent?.key ?? null,
          issueType: f.issuetype?.name ?? null,
          resolvedAt: f.resolutiondate ? new Date(f.resolutiondate) : null,
          status: f.status?.name ?? null,
          storyPoints,
          summary: f.summary ?? null,
          syncedAt: new Date(),
        },
        where: { key },
      });
      synced += 1;
    }

    logger?.info({ candidates: keys.length, jobName, missing, synced }, 'sync-jira: completed');

    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Job failed');
    if (jobRunId !== undefined) {
      await db.jobRun
        .update({
          data: { errorText, finishedAt: new Date(), status: 'error' },
          where: { id: jobRunId },
        })
        .catch(() => {});
    }
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(hashtext(${`job:${jobName}`}))`.catch(() => {});
  }
}
