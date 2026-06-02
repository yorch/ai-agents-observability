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

/** Leading marker identifying a bot-authored summary comment (for idempotency). */
export const COMMENT_MARKER = '🤖 **Claude Code summary**';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function buildCommentBody(rollup: PRRollupLike, config: RepoConfig): string {
  const lines: string[] = [COMMENT_MARKER];

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

  const existing = await client.request(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { issue_number: prNumber, owner: repoOwner, per_page: 100, repo: repoName },
  );
  const alreadyPosted = (existing.data as Array<{ body?: string | null }>).some((cm) =>
    cm.body?.includes(COMMENT_MARKER),
  );
  if (alreadyPosted) {
    return false;
  }

  await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    body,
    issue_number: prNumber,
    owner: repoOwner,
    repo: repoName,
  });
  return true;
}
