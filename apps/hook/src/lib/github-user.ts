// Resolve the authenticated GitHub user's login and team membership.
// Used by the flusher to populate session_context.git fields before events
// are shipped to ingest — keeping the hook hot path network-free.

/**
 * Return the GitHub login for the currently authenticated gh CLI user,
 * or null when gh is unavailable or not authenticated.
 */
export function fetchGitHubLogin(): string | null {
  try {
    const proc = Bun.spawnSync(['gh', 'api', 'user', '--jq', '.login'], {
      stderr: 'ignore',
      stdout: 'pipe',
    });
    if (proc.exitCode !== 0) {
      return null;
    }
    const login = new TextDecoder().decode(proc.stdout).trim();
    return login || null;
  } catch {
    return null;
  }
}

/**
 * Return the name of the first GitHub team the authenticated user belongs to
 * within the given `owner` org, or null if not in any team or an error occurs.
 * Fetches up to 100 team memberships via the gh CLI in a single call.
 */
export function fetchUserTeam(owner: string): string | null {
  try {
    const proc = Bun.spawnSync(['gh', 'api', 'user/teams?per_page=100'], {
      stderr: 'ignore',
      stdout: 'pipe',
    });
    if (proc.exitCode !== 0) {
      return null;
    }
    const teams = JSON.parse(new TextDecoder().decode(proc.stdout)) as Array<{
      name: string;
      organization: { login: string };
    }>;
    const match = teams.find((t) => t.organization?.login?.toLowerCase() === owner.toLowerCase());
    return match?.name ?? null;
  } catch {
    return null;
  }
}
