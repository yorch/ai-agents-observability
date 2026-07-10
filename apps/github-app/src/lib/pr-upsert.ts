import { isUniqueViolation, type PrismaClient } from '@ai-agents-observability/db';
import { parseRepoFullName } from '@ai-agents-observability/github';
import { extractJiraKeyFromSources } from '@ai-agents-observability/schemas';

type PRState = 'OPEN' | 'CLOSED' | 'MERGED';

type PullRequestPayload = {
  additions?: number;
  base: { ref: string };
  body?: string | null;
  changed_files?: number;
  deletions?: number;
  draft?: boolean;
  head: { ref: string };
  html_url: string;
  id: number; // github_id
  labels: Array<{ name: string }>;
  merged: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  number: number;
  requested_reviewers: Array<{ login: string }>;
  title: string;
  user: { login: string } | null; // null for deleted/ghost accounts
};

type RepoPayload = {
  default_branch?: string;
  full_name: string; // "owner/name"
  id: number;
};

export type PrUpsertDb = Pick<PrismaClient, 'repo' | 'pullRequest' | 'user'>;

// P5-004 originally defined extractJiraKey here; it now lives in
// @ai-agents-observability/schemas so ingest extracts session-level keys with
// the same rules. Re-exported to keep existing imports working.
export { extractJiraKey } from '@ai-agents-observability/schemas';

export async function upsertPullRequest(
  db: PrUpsertDb,
  repoPl: RepoPayload,
  prPl: PullRequestPayload,
  state: PRState,
): Promise<{ repoId: string; prNumber: number }> {
  // Two webhook deliveries for the same new repo/PR (e.g. opened + synchronize
  // arriving together) can race: both take the create path and one hits a
  // unique-constraint violation (P2002), a known Prisma upsert behaviour. Retry
  // once — the second pass finds the now-existing rows and takes the update path.
  try {
    return await doUpsert(db, repoPl, prPl, state);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return await doUpsert(db, repoPl, prPl, state);
    }
    throw err;
  }
}

async function doUpsert(
  db: PrUpsertDb,
  repoPl: RepoPayload,
  prPl: PullRequestPayload,
  state: PRState,
): Promise<{ repoId: string; prNumber: number }> {
  const parsed = parseRepoFullName(repoPl.full_name);
  if (!parsed) {
    throw new Error(`upsertPullRequest: malformed repository full_name "${repoPl.full_name}"`);
  }
  const { name, owner } = parsed;

  // Lazy-upsert the repo row (default_branch feeds push→session correlation)
  const repo = await db.repo.upsert({
    create: {
      defaultBranch: repoPl.default_branch ?? null,
      githubId: BigInt(repoPl.id),
      githubName: name,
      githubOwner: owner,
    },
    update: {
      githubId: BigInt(repoPl.id),
      ...(repoPl.default_branch ? { defaultBranch: repoPl.default_branch } : {}),
    },
    where: { githubOwner_githubName: { githubName: name, githubOwner: owner } },
  });

  // Resolve authorUserId by login (user is null for deleted/ghost accounts)
  const authorLogin = prPl.user?.login ?? 'ghost';
  const authorUser = prPl.user
    ? await db.user.findUnique({ where: { githubLogin: prPl.user.login } })
    : null;

  // P5-004: extract Jira key — head branch first (the strongest convention),
  // then PR title, then PR body, for repos without disciplined branch naming.
  const jiraKey = extractJiraKeyFromSources(prPl.head.ref, prPl.title, prPl.body);

  await db.pullRequest.upsert({
    create: {
      authorGithubLogin: authorLogin,
      authorUserId: authorUser?.id ?? null,
      baseBranch: prPl.base.ref,
      closedAt: prPl.closed_at ? new Date(prPl.closed_at) : null,
      filesChanged: prPl.changed_files ?? null,
      githubId: BigInt(prPl.id),
      headBranch: prPl.head.ref,
      isDraft: prPl.draft ?? null,
      jiraKey,
      labels: prPl.labels.map((l) => l.name),
      linesAdded: prPl.additions ?? null,
      linesRemoved: prPl.deletions ?? null,
      mergedAt: prPl.merged_at ? new Date(prPl.merged_at) : null,
      openedAt: new Date(prPl.created_at),
      prNumber: prPl.number,
      repoId: repo.id,
      reviewerLogins: prPl.requested_reviewers.map((r) => r.login),
      state,
      title: prPl.title,
    },
    update: {
      authorUserId: authorUser?.id ?? null,
      closedAt: prPl.closed_at ? new Date(prPl.closed_at) : null,
      jiraKey,
      labels: prPl.labels.map((l) => l.name),
      mergedAt: prPl.merged_at ? new Date(prPl.merged_at) : null,
      reviewerLogins: prPl.requested_reviewers.map((r) => r.login),
      state,
      title: prPl.title,
      // Diff-stat fields are absent from the abbreviated PR object that
      // non-pull_request webhooks (e.g. pull_request_review) carry. Only
      // overwrite them when the payload actually has them — otherwise a review
      // event would null out metrics a prior pull_request delivery populated.
      ...(prPl.additions !== undefined ? { linesAdded: prPl.additions } : {}),
      ...(prPl.deletions !== undefined ? { linesRemoved: prPl.deletions } : {}),
      ...(prPl.changed_files !== undefined ? { filesChanged: prPl.changed_files } : {}),
      ...(prPl.draft !== undefined ? { isDraft: prPl.draft } : {}),
    },
    where: { repoId_prNumber: { prNumber: prPl.number, repoId: repo.id } },
  });

  return { prNumber: prPl.number, repoId: repo.id };
}
