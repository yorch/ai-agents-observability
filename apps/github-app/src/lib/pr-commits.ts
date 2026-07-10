import { resolveApiBase } from '@ai-agents-observability/github';

// Cap on commits fetched per PR (3 pages of 100). PRs beyond this are extreme
// outliers; branch-name matching still covers their sessions.
const MAX_PAGES = 3;
const PER_PAGE = 100;

/**
 * List the commit SHAs belonging to a PR via the REST API (installation token).
 * Best-effort: returns [] on any error — SHA matching is an enhancement on top
 * of branch-name matching, never a reason to fail the webhook.
 */
export async function fetchPRCommitShas(
  owner: string,
  name: string,
  prNumber: number,
  installToken: string,
  githubHost: string,
): Promise<string[]> {
  const apiBase = resolveApiBase(githubHost);
  const shas: string[] = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${prNumber}/commits?per_page=${PER_PAGE}&page=${page}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${installToken}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (!res.ok) {
        return shas;
      }
      const commits = (await res.json()) as Array<{ sha: string }>;
      for (const c of commits) {
        if (c.sha) {
          shas.push(c.sha);
        }
      }
      if (commits.length < PER_PAGE) {
        break;
      }
    }
  } catch {
    return shas;
  }

  return shas;
}
