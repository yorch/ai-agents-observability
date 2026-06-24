import type { GitContext } from '@ai-agents-observability/schemas';

// Run a git command in `cwd`, returning trimmed stdout or null on any failure
// (non-zero exit, git missing, cwd gone). Synchronous: only ever called off the
// hot path (in the flusher daemon), never from the hook entrypoint.
function run(cwd: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, ...args], {
      stderr: 'ignore',
      stdout: 'pipe',
    });
    if (proc.exitCode !== 0) {
      return null;
    }
    const out = new TextDecoder().decode(proc.stdout).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// Parse `owner` / `repo` from a git remote URL. Handles both SSH
// (git@github.com:owner/repo.git) and HTTPS (https://host/owner/repo(.git)).
function parseOwnerRepo(remoteUrl: string | null): {
  owner: string | null;
  repo: string | null;
} {
  if (!remoteUrl) {
    return { owner: null, repo: null };
  }
  const match = remoteUrl.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) {
    return { owner: null, repo: null };
  }
  return { owner: match[1] ?? null, repo: match[2] ?? null };
}

/**
 * Resolve git context for a working directory. Returns null when `cwd` is not a
 * git repository (or git is unavailable), so the caller leaves `git: null`.
 *
 * Computed at flush time rather than capture time to keep the hook hot path
 * under budget (P1-021). For short-lived sessions this is effectively
 * capture-time; a session that switches branches between an event and the flush
 * records the branch as of the flush — an accepted v1 trade-off.
 */
export function getGitContext(cwd: string): GitContext | null {
  const commit = run(cwd, ['rev-parse', 'HEAD']);
  if (commit === null) {
    return null; // not a git repo
  }
  const branch = run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remoteUrl = run(cwd, ['remote', 'get-url', 'origin']);
  const status = run(cwd, ['status', '--porcelain']);
  const { owner, repo } = parseOwnerRepo(remoteUrl);
  return {
    branch: branch === 'HEAD' ? null : branch, // detached HEAD
    commit,
    is_dirty: status !== null,
    owner,
    pr_number: null,
    remote_url: remoteUrl,
    repo,
  };
}
