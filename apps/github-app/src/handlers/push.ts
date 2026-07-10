import { parseRepoFullName } from '@ai-agents-observability/github';
import type { Logger } from 'pino';
import type { Config } from '../config';
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

type CandidateSession = { lastEventAt: Date; sessionId: string; startedAt: Date };

/**
 * push webhook on the default branch → commit→session correlation
 * (DESIGN_DOC §7.2): match by repo + commit author login + timestamp window
 * (session activity extended by COMMIT_LINK_GRACE_HOURS — devs routinely
 * commit shortly after the agent session ends), recorded in
 * session_commit_links. Also keeps repos.default_branch current.
 *
 * One session query per distinct author covers all of the push's commits;
 * per-commit matching happens in memory and all links land in one createMany.
 */
export async function handlePush(
  payload: PushPayload,
  db: AppDb,
  config: Config,
  logger: Logger,
): Promise<void> {
  const repoFullName = payload.repository?.full_name;
  const defaultBranch = payload.repository?.default_branch;
  if (!repoFullName || !payload.ref) {
    return;
  }

  const parsed = parseRepoFullName(repoFullName);
  if (!parsed) {
    logger.warn({ repoFullName }, 'push: unexpected repository full_name format');
    return;
  }

  // Only default-branch pushes count as "merged work" for correlation.
  if (!defaultBranch || payload.ref !== `refs/heads/${defaultBranch}`) {
    return;
  }

  const repo = await db.repo.findFirst({
    select: { defaultBranch: true, id: true },
    where: { githubName: parsed.name, githubOwner: parsed.owner },
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

  const graceMs = config.commit_link_grace_hours * 60 * 60 * 1000;

  // Group the push's commits by author so each author needs one session query.
  const byAuthor = new Map<string, Array<{ committedAt: Date; sha: string }>>();
  for (const commit of payload.commits ?? []) {
    const authorLogin = commit.author?.username;
    if (!authorLogin || !commit.id) {
      continue;
    }
    const committedAt = commit.timestamp ? new Date(commit.timestamp) : null;
    if (!committedAt || Number.isNaN(committedAt.getTime())) {
      continue;
    }
    const list = byAuthor.get(authorLogin) ?? [];
    list.push({ committedAt, sha: commit.id });
    byAuthor.set(authorLogin, list);
  }

  const links: Array<{
    authorLogin: string;
    commitSha: string;
    committedAt: Date;
    repoId: string;
    sessionId: string;
  }> = [];

  for (const [authorLogin, commits] of byAuthor) {
    const times = commits.map((c) => c.committedAt.getTime());
    const windowMin = new Date(Math.min(...times) - graceMs);
    const windowMax = new Date(Math.max(...times));

    // Superset window for all of this author's commits; exact per-commit
    // matching (start ≤ commit ≤ lastEvent + grace) happens below in memory.
    const sessions: CandidateSession[] = await db.session.findMany({
      select: { lastEventAt: true, sessionId: true, startedAt: true },
      where: {
        githubLogin: authorLogin,
        lastEventAt: { gte: windowMin },
        repoId: repo.id,
        startedAt: { lte: windowMax },
      },
    });
    if (sessions.length === 0) {
      continue;
    }

    for (const { committedAt, sha } of commits) {
      const ts = committedAt.getTime();
      for (const s of sessions) {
        if (s.startedAt.getTime() <= ts && s.lastEventAt.getTime() >= ts - graceMs) {
          links.push({
            authorLogin,
            commitSha: sha,
            committedAt,
            repoId: repo.id,
            sessionId: s.sessionId,
          });
        }
      }
    }
  }

  if (links.length === 0) {
    return;
  }

  await db.sessionCommitLink.createMany({ data: links, skipDuplicates: true });
  logger.info({ linked: links.length, repo: repoFullName }, 'push.commit_links');
}
