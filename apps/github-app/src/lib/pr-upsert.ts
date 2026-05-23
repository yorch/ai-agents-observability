import type { PrismaClient } from '@ai-agents-observability/db';

type PRState = 'open' | 'closed' | 'merged';

type PullRequestPayload = {
  additions?: number;
  base: { ref: string };
  body?: string | null;
  changed_files?: number;
  deletions?: number;
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
  full_name: string; // "owner/name"
  id: number;
};

export type PrUpsertDb = Pick<PrismaClient, 'repo' | 'pullRequest' | 'user'>;

export async function upsertPullRequest(
  db: PrUpsertDb,
  repoPl: RepoPayload,
  prPl: PullRequestPayload,
  state: PRState,
): Promise<{ repoId: string; prNumber: number }> {
  const [owner, name] = repoPl.full_name.split('/') as [string, string];

  // Lazy-upsert the repo row
  const repo = await db.repo.upsert({
    create: { githubId: BigInt(repoPl.id), githubName: name, githubOwner: owner },
    update: { githubId: BigInt(repoPl.id) },
    where: { githubOwner_githubName: { githubName: name, githubOwner: owner } },
  });

  // Resolve authorUserId by login (user is null for deleted/ghost accounts)
  const authorLogin = prPl.user?.login ?? 'ghost';
  const authorUser = prPl.user
    ? await db.user.findUnique({ where: { githubLogin: prPl.user.login } })
    : null;

  await db.pullRequest.upsert({
    create: {
      authorGithubLogin: authorLogin,
      authorUserId: authorUser?.id ?? null,
      baseBranch: prPl.base.ref,
      closedAt: prPl.closed_at ? new Date(prPl.closed_at) : null,
      filesChanged: prPl.changed_files ?? null,
      githubId: BigInt(prPl.id),
      headBranch: prPl.head.ref,
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
      filesChanged: prPl.changed_files ?? null,
      labels: prPl.labels.map((l) => l.name),
      linesAdded: prPl.additions ?? null,
      linesRemoved: prPl.deletions ?? null,
      mergedAt: prPl.merged_at ? new Date(prPl.merged_at) : null,
      reviewerLogins: prPl.requested_reviewers.map((r) => r.login),
      state,
      title: prPl.title,
    },
    where: { repoId_prNumber: { prNumber: prPl.number, repoId: repo.id } },
  });

  return { prNumber: prPl.number, repoId: repo.id };
}
