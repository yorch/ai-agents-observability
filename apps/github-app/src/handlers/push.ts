import type { Logger } from 'pino';
import type { AppDb } from '../types';

// Structural payload shape — webhooks.ts parses the body as a plain object.
export type PushPayload = {
  commits?: Array<{
    author?: { username?: string | null };
    id: string;
    timestamp?: string;
  }>;
  ref?: string;
  repository?: { default_branch?: string; full_name?: string };
};

// A commit is attributed to a session when it lands within the session's
// activity window, extended by this grace period — devs routinely commit
// shortly after the agent session ends.
const COMMIT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * push webhook on the default branch → commit→session correlation
 * (DESIGN_DOC §7.2): match by repo + commit author login + timestamp window,
 * recorded in session_commit_links. Also keeps repos.default_branch current.
 */
export async function handlePush(payload: PushPayload, db: AppDb, logger: Logger): Promise<void> {
  const repoFullName = payload.repository?.full_name;
  const defaultBranch = payload.repository?.default_branch;
  if (!repoFullName || !payload.ref) {
    return;
  }

  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    logger.warn({ repoFullName }, 'push: unexpected repository full_name format');
    return;
  }
  const [owner, name] = parts as [string, string];

  // Only default-branch pushes count as "merged work" for correlation.
  if (!defaultBranch || payload.ref !== `refs/heads/${defaultBranch}`) {
    return;
  }

  const repo = await db.repo.findFirst({
    select: { defaultBranch: true, id: true },
    where: { githubName: name, githubOwner: owner },
  });
  if (!repo) {
    return;
  }

  if (repo.defaultBranch !== defaultBranch) {
    await db.repo.update({
      data: { defaultBranch },
      where: { id: repo.id },
    });
  }

  let linked = 0;
  for (const commit of payload.commits ?? []) {
    const authorLogin = commit.author?.username;
    if (!authorLogin || !commit.id) {
      continue;
    }
    const committedAt = commit.timestamp ? new Date(commit.timestamp) : null;
    if (!committedAt || Number.isNaN(committedAt.getTime())) {
      continue;
    }

    // Author + timestamp window: the commit falls between session start and
    // last activity + grace. github_login is the hook-reported author identity.
    const sessions = await db.session.findMany({
      select: { sessionId: true },
      where: {
        githubLogin: authorLogin,
        lastEventAt: { gte: new Date(committedAt.getTime() - COMMIT_GRACE_MS) },
        repoId: repo.id,
        startedAt: { lte: committedAt },
      },
    });
    if (sessions.length === 0) {
      continue;
    }

    await db.sessionCommitLink.createMany({
      data: sessions.map((s) => ({
        authorLogin,
        commitSha: commit.id,
        committedAt,
        repoId: repo.id,
        sessionId: s.sessionId,
      })),
      skipDuplicates: true,
    });
    linked += sessions.length;
  }

  if (linked > 0) {
    logger.info({ linked, repo: repoFullName }, 'push.commit_links');
  }
}
