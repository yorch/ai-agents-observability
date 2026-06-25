// Resolve the open GitHub PR number for a given owner/repo/branch.
// Used by the flusher to populate session_context.git.pr_number before
// events are shipped to ingest — keeping the hook hot path network-free.

function githubApiBase(): string {
  return (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
}

/**
 * True if `remoteUrl` points at a GitHub host. Used to gate the API fallback
 * path — the gh CLI path doesn't need this check since gh itself knows its host.
 */
export function isGitHubRemote(remoteUrl: string | null): boolean {
  if (!remoteUrl) {
    return false;
  }
  const apiBase = githubApiBase();
  if (apiBase !== 'https://api.github.com') {
    try {
      const gheHost = new URL(apiBase).hostname;
      return remoteUrl.includes(gheHost);
    } catch {
      // fall through
    }
  }
  return /github\.com/i.test(remoteUrl);
}

// Primary path: gh CLI handles host, auth, token refresh, and GHES automatically.
function fetchPrNumberViaGh(owner: string, repo: string, branch: string): number | null {
  try {
    const proc = Bun.spawnSync(
      [
        'gh',
        'pr',
        'list',
        '--head',
        branch,
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'number',
        '--state',
        'open',
        '--limit',
        '1',
      ],
      { stderr: 'ignore', stdout: 'pipe' },
    );
    if (proc.exitCode !== 0) {
      return null;
    }
    const prs = JSON.parse(new TextDecoder().decode(proc.stdout)) as Array<{ number: number }>;
    return prs[0]?.number ?? null;
  } catch {
    return null;
  }
}

// Fallback: raw REST API for CI/CD environments where gh is not installed.
async function fetchPrNumberViaApi(
  owner: string,
  repo: string,
  branch: string,
  remoteUrl: string | null,
): Promise<number | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (!token || !isGitHubRemote(remoteUrl)) {
    return null;
  }
  try {
    const url = `${githubApiBase()}/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open&per_page=1`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      return null;
    }
    const pulls = (await res.json()) as Array<{ number: number }>;
    return pulls[0]?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * Return the open PR number for `branch` in `owner/repo`, or null when none
 * is found or an error occurs. Tries the gh CLI first (preferred — handles
 * host, auth, and GHES automatically); falls back to a direct REST API call
 * using GITHUB_TOKEN / GH_TOKEN for environments where gh is not installed.
 */
export async function fetchOpenPrNumber(
  owner: string,
  repo: string,
  branch: string,
  remoteUrl: string | null = null,
): Promise<number | null> {
  return (
    fetchPrNumberViaGh(owner, repo, branch) ??
    (await fetchPrNumberViaApi(owner, repo, branch, remoteUrl))
  );
}
