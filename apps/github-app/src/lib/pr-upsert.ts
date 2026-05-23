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
  user: { login: string };
};

type RepoPayload = {
  full_name: string; // "owner/name"
  id: number;
};

type PrUpsertDb = Pick<PrismaClient, 'repo' | 'pullRequest' | 'user'>;

export async function upsertPullRequest(
  db: PrUpsertDb,
  repoPl: RepoPayload,
  prPl: PullRequestPayload,
  state: PRState,
): Promise<{ repoId: string; prNumber: number }> {
  const [owner, name] = repoPl.full_name.split('/') as [string, string];

  // Lazy-upsert the repo row
  const repo = await db.repo.upsert({
    where: { githubOwner_githubName: { githubName: name, githubOwner: owner } },
    create: { githubOwner: owner, githubName: name, githubId: BigInt(repoPl.id) },
    update: { githubId: BigInt(repoPl.id) },
  });

  // Resolve authorUserId by login
  const authorUser = await db.user.findUnique({ where: { githubLogin: prPl.user.login } });

  await db.pullRequest.upsert({
    where: { repoId_prNumber: { repoId: repo.id, prNumber: prPl.number } },
    create: {
      repoId: repo.id,
      prNumber: prPl.number,
      githubId: BigInt(prPl.id),
      title: prPl.title,
      state,
      authorGithubLogin: prPl.user.login,
      authorUserId: authorUser?.id ?? null,
      baseBranch: prPl.base.ref,
      headBranch: prPl.head.ref,
      openedAt: new Date(prPl.created_at),
      closedAt: prPl.closed_at ? new Date(prPl.closed_at) : null,
      mergedAt: prPl.merged_at ? new Date(prPl.merged_at) : null,
      linesAdded: prPl.additions ?? null,
      linesRemoved: prPl.deletions ?? null,
      filesChanged: prPl.changed_files ?? null,
      reviewerLogins: prPl.requested_reviewers.map((r) => r.login),
      labels: prPl.labels.map((l) => l.name),
    },
    update: {
      title: prPl.title,
      state,
      closedAt: prPl.closed_at ? new Date(prPl.closed_at) : null,
      mergedAt: prPl.merged_at ? new Date(prPl.merged_at) : null,
      linesAdded: prPl.additions ?? null,
      linesRemoved: prPl.deletions ?? null,
      filesChanged: prPl.changed_files ?? null,
      reviewerLogins: prPl.requested_reviewers.map((r) => r.login),
      labels: prPl.labels.map((l) => l.name),
      authorUserId: authorUser?.id ?? null,
    },
  });

  return { repoId: repo.id, prNumber: prPl.number };
}
