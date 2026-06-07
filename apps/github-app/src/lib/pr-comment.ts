import { createGitHubClient } from '@ai-agents-observability/github';
import type { RepoConfig } from '@ai-agents-observability/schemas';

// Minimal shape matching the PRRollup model (no dependency on generated client)
type PRRollupLike = {
  contributingSessionIds: string[];
  contributingUserIds: string[];
  totalActiveSeconds: number | null;
  totalCostUsd: { toString(): string } | number | string | null;
  totalToolCalls: number | null;
};

/** Hidden HTML marker for deduplication — agent-neutral, not exposed in rendered output. */
export const COMMENT_MARKER = '<!-- ai-agents-observability:pr-summary -->';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function buildCommentBody(rollup: PRRollupLike, config: RepoConfig): string {
  const lines: string[] = [COMMENT_MARKER, '🤖 **AI agent summary**'];

  const sessions = rollup.contributingSessionIds.length;
  const contributors = rollup.contributingUserIds.length;
  lines.push(
    `• ${sessions} session${sessions !== 1 ? 's' : ''} · ${contributors} contributor${contributors !== 1 ? 's' : ''}`,
  );

  if (config.pr_bot.include_cost) {
    const cost = Number(rollup.totalCostUsd ?? 0).toFixed(2);
    const tools =
      config.pr_bot.include_tool_counts && rollup.totalToolCalls != null
        ? ` · ${rollup.totalToolCalls} tool calls`
        : '';
    lines.push(`• $${cost} total cost${tools}`);
  }

  if (rollup.totalActiveSeconds != null) {
    // Sum of contributing-session durations — active time, not wall-clock span.
    lines.push(`• Active time: ${formatDuration(rollup.totalActiveSeconds)}`);
  }

  return lines.join('\n');
}

/**
 * Post the summary comment, idempotently. GitHub re-delivers webhooks, so before
 * posting we list existing PR comments and skip if a bot summary (identified by
 * {@link COMMENT_MARKER}) is already present. Returns true if a comment was posted.
 */
export async function postPRComment(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  body: string,
  installationToken: string,
  githubHost: string,
): Promise<boolean> {
  const client = createGitHubClient({ host: githubHost, token: installationToken });

  // Scan ALL comment pages for an existing bot summary, not just the first 100 —
  // on a busy PR the marker can sit beyond page 1 and a single-page check would
  // re-post a duplicate. Bounded at MAX_PAGES so a pathological PR can't loop.
  const PER_PAGE = 100;
  const MAX_PAGES = 20; // up to 2000 comments
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      issue_number: prNumber,
      owner: repoOwner,
      page,
      per_page: PER_PAGE,
      repo: repoName,
    });
    const comments = resp.data as Array<{ body?: string | null }>;
    if (comments.some((cm) => cm.body?.includes(COMMENT_MARKER))) {
      return false;
    }
    if (comments.length < PER_PAGE) {
      break; // last page reached
    }
  }

  await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    body,
    issue_number: prNumber,
    owner: repoOwner,
    repo: repoName,
  });
  return true;
}
