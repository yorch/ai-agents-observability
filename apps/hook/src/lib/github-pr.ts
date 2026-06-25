// Resolve the open GitHub PR number for a given owner/repo/branch.
// Used by the flusher to populate session_context.git.pr_number before
// events are shipped to ingest — keeping the hook hot path network-free.

/**
 * Find a GitHub token from the environment or the gh CLI.
 * Returns null when none is available; callers treat that as "skip PR lookup".
 */
export function resolveGitHubToken(): string | null {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (env.length > 0) {
    return env;
  }
  try {
    const proc = Bun.spawnSync(['gh', 'auth', 'token'], { stderr: 'ignore', stdout: 'pipe' });
    if (proc.exitCode === 0) {
      const tok = new TextDecoder().decode(proc.stdout).trim();
      if (tok.length > 0) {
        return tok;
      }
    }
  } catch {
    // gh not installed or not authenticated — not an error
  }
  return null;
}

function githubApiBase(): string {
  // Supports GitHub Enterprise via GITHUB_API_URL (the same env var gh CLI uses)
  return (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
}

/**
 * Return true if `remoteUrl` points at a GitHub host (github.com or the host
 * in GITHUB_API_URL for GitHub Enterprise). Non-GitHub remotes (GitLab,
 * Bitbucket, etc.) are skipped — we don't want spurious API calls.
 */
export function isGitHubRemote(remoteUrl: string | null): boolean {
  if (!remoteUrl) {
    return false;
  }
  const apiBase = githubApiBase();
  if (apiBase !== 'https://api.github.com') {
    // GHES: derive the enterprise host from GITHUB_API_URL and match it
    try {
      const gheHost = new URL(apiBase).hostname;
      return remoteUrl.includes(gheHost);
    } catch {
      // fall through to github.com check
    }
  }
  return /github\.com/i.test(remoteUrl);
}

/**
 * Fetch the number of the first open PR whose head branch matches `branch` in
 * `owner/repo`. Returns null on any error (network, auth, no PR found, non-GitHub
 * remote) so callers can treat null as "leave pr_number unset".
 */
export async function fetchOpenPrNumber(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  remoteUrl: string | null = null,
): Promise<number | null> {
  if (!isGitHubRemote(remoteUrl)) {
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
