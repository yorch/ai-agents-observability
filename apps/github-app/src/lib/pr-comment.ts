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

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function buildCommentBody(rollup: PRRollupLike, config: RepoConfig): string {
  const lines: string[] = ['🤖 **Claude Code summary**'];

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
    lines.push(
      `• Time span: ${formatDuration(rollup.totalActiveSeconds)} (first session → merge)`,
    );
  }

  return lines.join('\n');
}

export async function postPRComment(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  body: string,
  installationToken: string,
  githubHost: string,
): Promise<void> {
  const client = createGitHubClient({ token: installationToken, host: githubHost });
  await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: repoOwner,
    repo: repoName,
    issue_number: prNumber,
    body,
  });
}
