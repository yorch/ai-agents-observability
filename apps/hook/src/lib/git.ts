import type { GitContext } from '@ai-agents-observability/schemas';

// Run a git command in `cwd`, returning trimmed stdout or null on any failure
// (non-zero exit, git missing, cwd gone). Synchronous. Called from two sites:
// the flusher daemon (off the hot path) and hook-entry for SessionStart events
// (once per session, so the one-time latency is acceptable).
// A wedged git is the failure this bounds, not a slow one. `git status` on a
// stale NFS/SMB mount, or with a broken `core.fsmonitor`, blocks in
// uninterruptible sleep and never returns — and `run` is called from
// `hook-entry`, which the host agent waits on. Without a bound, the hook does
// not merely miss its <10ms budget: it stalls the developer's session until the
// agent's own hook timeout fires. `adapters/gemini-cli.ts` already spawns with
// `timeout: 5000`; this is the same idiom, not a new policy.
//
// 2s rather than 5s because this one is on the hot path: it is far longer than
// any healthy git call (measured median for the full four-call sequence is
// ~23ms) and short enough that a hang degrades to "no git context" rather than
// to a visible freeze. Timing out returns null, which the caller already
// handles as "not a git repo".
const GIT_TIMEOUT_MS = 2000;

function run(cwd: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, ...args], {
      stderr: 'ignore',
      stdout: 'pipe',
      timeout: GIT_TIMEOUT_MS,
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
 * Called at session-start capture time (hook-entry.ts) to lock in the branch as
 * of when the session began. Also called by the flusher to backfill git on all
 * other event types, where flush-time branch is an acceptable approximation.
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
