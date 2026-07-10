import type { PrismaClient } from '@ai-agents-observability/db';
import type { Logger } from 'pino';

import { withJobRun } from './job-run';

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
  // Classic (company-managed pre-parent-field) projects carry the epic in an
  // "Epic Link" custom field (e.g. customfield_10014) instead of `parent`.
  // Used as a fallback when `parent` is absent.
  epicLinkField?: string;
};

export type SyncJiraDb = Pick<
  PrismaClient,
  'jiraIssue' | 'jiraIssueLink' | 'jobRun' | 'pullRequest' | 'session'
> & {
  $queryRaw: PrismaClient['$queryRaw'];
};

// Re-sync an issue only when its snapshot is older than this. Keys never seen
// before always sync.
const RESYNC_AFTER_MS = 6 * 60 * 60 * 1000;

// Upper bound of API calls per run; the remainder syncs on later runs.
const MAX_ISSUES_PER_RUN = 500;

// Concurrent in-flight Jira requests — enough to cut wall time ~10x without
// tripping Jira Cloud rate limits.
const FETCH_CONCURRENCY = 8;

type JiraIssueLinkRaw = {
  inwardIssue?: { key?: string } | null;
  outwardIssue?: { key?: string } | null;
  type?: { inward?: string; name?: string; outward?: string } | null;
};

type JiraIssueFields = {
  assignee?: { displayName?: string; emailAddress?: string; name?: string } | null;
  created?: string | null;
  issuelinks?: JiraIssueLinkRaw[] | null;
  issuetype?: { name?: string } | null;
  parent?: { key?: string } | null;
  project?: { key?: string; name?: string } | null;
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

// 'missing' = 404: the key was extracted from a branch/title and may simply not
// be a real issue. Anything else non-2xx (401/403/429/5xx) throws — those are
// sync failures, not missing issues, and must not masquerade as success.
async function fetchIssue(
  config: JiraSyncConfig,
  key: string,
): Promise<{ fields: JiraIssueFields } | 'missing'> {
  const base = config.baseUrl.replace(/\/$/, '');
  const fields = [
    'summary',
    'issuetype',
    'status',
    'parent',
    'project',
    'assignee',
    'created',
    'issuelinks',
    'resolutiondate',
    ...(config.storyPointsField ? [config.storyPointsField] : []),
    ...(config.epicLinkField ? [config.epicLinkField] : []),
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
  if (res.status === 404) {
    return 'missing';
  }
  if (!res.ok) {
    throw new Error(`Jira responded ${res.status} for ${key}`);
  }
  return (await res.json()) as { fields: JiraIssueFields };
}

async function syncIssue(
  db: SyncJiraDb,
  config: JiraSyncConfig,
  key: string,
): Promise<'synced' | 'missing'> {
  const issue = await fetchIssue(config, key);
  if (issue === 'missing') {
    return 'missing';
  }

  const f = issue.fields;
  const storyPointsRaw = config.storyPointsField ? f[config.storyPointsField] : null;
  // Epic: modern projects use `parent`; classic projects use the Epic Link
  // custom field, whose value is the epic's issue key as a string.
  const epicLinkRaw = config.epicLinkField ? f[config.epicLinkField] : null;

  const data = {
    assignee: f.assignee?.displayName ?? f.assignee?.name ?? null,
    epicKey: f.parent?.key ?? (typeof epicLinkRaw === 'string' ? epicLinkRaw : null),
    issueCreatedAt: f.created ? new Date(f.created) : null,
    issueType: f.issuetype?.name ?? null,
    // Project key falls back to the issue-key prefix (PLAT-123 → PLAT) if the
    // API record somehow omits project; name is API-only (display value).
    projectKey: f.project?.key ?? key.slice(0, key.indexOf('-')),
    projectName: f.project?.name ?? null,
    resolvedAt: f.resolutiondate ? new Date(f.resolutiondate) : null,
    status: f.status?.name ?? null,
    storyPoints: typeof storyPointsRaw === 'number' ? storyPointsRaw : null,
    summary: f.summary ?? null,
  };

  await db.jiraIssue.upsert({
    create: { key, ...data },
    update: { ...data, syncedAt: new Date() },
    where: { key },
  });

  // Snapshot this issue's links (delete + recreate: links can be removed in
  // Jira, and the per-issue set is tiny). `description` keeps the relation
  // phrase from this issue's perspective ("is caused by", "relates to", …) so
  // defect attribution reports linkage verbatim rather than inferring causation.
  const links = (f.issuelinks ?? []).flatMap((raw) => {
    const related = raw.inwardIssue?.key ?? raw.outwardIssue?.key;
    if (!related || !raw.type?.name) {
      return [];
    }
    return [
      {
        description: (raw.inwardIssue ? raw.type.inward : raw.type.outward) ?? null,
        linkType: raw.type.name,
        sourceKey: key,
        targetKey: related,
      },
    ];
  });
  await db.jiraIssueLink.deleteMany({ where: { sourceKey: key } });
  if (links.length > 0) {
    await db.jiraIssueLink.createMany({ data: links, skipDuplicates: true });
  }
  return 'synced';
}

export async function runSyncJira(
  db: SyncJiraDb,
  config: JiraSyncConfig,
  logger?: Logger,
): Promise<void> {
  await withJobRun(db, 'sync-jira', logger, async () => {
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
    // Plus every issue referenced by a synced issue's links — a bug linked to
    // one of our tickets is usually never worked on in a repo, so it would
    // otherwise never sync and defect attribution couldn't see its issue type.
    const linkTargets = await db.jiraIssueLink.findMany({
      distinct: ['targetKey'],
      select: { targetKey: true },
    });

    const allKeys = new Set<string>();
    for (const row of [...prKeys, ...sessionKeys]) {
      if (row.jiraKey) {
        allKeys.add(row.jiraKey);
      }
    }
    for (const row of linkTargets) {
      allKeys.add(row.targetKey);
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
    let failed = 0;

    for (let i = 0; i < keys.length; i += FETCH_CONCURRENCY) {
      const chunk = keys.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((key) => syncIssue(db, config, key)));
      for (const [j, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          if (result.value === 'synced') {
            synced += 1;
          } else {
            missing += 1;
          }
        } else {
          failed += 1;
          logger?.warn({ err: result.reason, key: chunk[j] }, 'sync-jira: fetch failed');
        }
      }
    }

    logger?.info(
      { candidates: keys.length, failed, jobName: 'sync-jira', missing, synced },
      'sync-jira: completed',
    );

    // All candidates failed and nothing synced — bad credentials or Jira down.
    // Surface it as a failed run instead of a green one.
    if (failed > 0 && synced === 0 && missing === 0) {
      throw new Error(`sync-jira: all ${failed} issue fetches failed`);
    }
  });
}
