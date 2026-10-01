// Resolve the open GitHub PR number for a given owner/repo/branch.
// Used by the flusher to populate session_context.git.pr_number before
// events are shipped to ingest — keeping the hook hot path network-free.

import { noteLookupFailure } from './lookup-status';

function githubApiBase(): string {
  return (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
}

type GhSpawn = typeof Bun.spawnSync;

// A wedged `gh` (a credential-helper prompt, a stalled TLS connection) or an
// API host that accepts the socket and never answers would block the flusher's
// only loop forever — `spawnSync` and Bun's `fetch` have no default bound.
// 15s is far above a healthy call (hundreds of ms) yet short enough that a hang
// degrades to "no enrichment" for one batch. A timed-out spawn reports exitCode
// null and a timed-out fetch throws; both already resolve to the null result.
export const GH_TIMEOUT_MS = 15_000;

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

/** A lookup's value plus whether the source actually answered (null can mean either). */
type Lookup = { ok: boolean; value: number | null };

// Primary path: gh CLI handles host, auth, token refresh, and GHES automatically.
function fetchPrNumberViaGh(owner: string, repo: string, branch: string, spawn: GhSpawn): Lookup {
  try {
    const proc = spawn(
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
      { stderr: 'ignore', stdout: 'pipe', timeout: GH_TIMEOUT_MS },
    );
    if (proc.exitCode !== 0) {
      return { ok: false, value: null };
    }
    const prs = JSON.parse(new TextDecoder().decode(proc.stdout)) as Array<{ number: number }>;
    return { ok: true, value: prs[0]?.number ?? null };
  } catch {
    return { ok: false, value: null };
  }
}

// Fallback: raw REST API for CI/CD environments where gh is not installed.
async function fetchPrNumberViaApi(
  owner: string,
  repo: string,
  branch: string,
  remoteUrl: string | null,
): Promise<Lookup> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (!token || !isGitHubRemote(remoteUrl)) {
    return { ok: false, value: null };
  }
  try {
    const url = `${githubApiBase()}/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open&per_page=1`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, value: null };
    }
    const pulls = (await res.json()) as Array<{ number: number }>;
    return { ok: true, value: pulls[0]?.number ?? null };
  } catch {
    return { ok: false, value: null };
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
  spawn: GhSpawn = Bun.spawnSync,
): Promise<number | null> {
  const viaGh = fetchPrNumberViaGh(owner, repo, branch, spawn);
  if (viaGh.value !== null) {
    return viaGh.value;
  }
  const viaApi = await fetchPrNumberViaApi(owner, repo, branch, remoteUrl);
  if (!viaGh.ok && !viaApi.ok) {
    // Neither source could be asked: "no PR" below means "unknown", not "none".
    noteLookupFailure();
  }
  return viaApi.value;
}

// ── PR snapshot (CI status + review decision) ─────────────────────────────

export type CiStatus = 'SUCCESS' | 'FAILURE' | 'PENDING';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export type PrSnapshot = {
  ciStatus: CiStatus | null;
  reviewDecision: ReviewDecision | null;
};

type GhCheck = { conclusion: string | null; status: string };

function deriveCiStatus(checks: GhCheck[]): CiStatus | null {
  if (checks.length === 0) {
    return null;
  }
  const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'CANCELLED']);
  let hasPending = false;
  for (const { conclusion, status } of checks) {
    if (FAIL.has(conclusion ?? '')) {
      return 'FAILURE';
    }
    if (status !== 'COMPLETED' || !PASS.has(conclusion ?? '')) {
      hasPending = true;
    }
  }
  return hasPending ? 'PENDING' : 'SUCCESS';
}

/**
 * Fetch a point-in-time snapshot of a PR's CI status and review decision via
 * the gh CLI. Returns null when gh is unavailable or the call fails.
 */
export function fetchPrSnapshot(
  owner: string,
  repo: string,
  prNumber: number,
  spawn: GhSpawn = Bun.spawnSync,
): PrSnapshot | null {
  try {
    const proc = spawn(
      [
        'gh',
        'pr',
        'view',
        String(prNumber),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'reviewDecision,statusCheckRollup',
      ],
      { stderr: 'ignore', stdout: 'pipe', timeout: GH_TIMEOUT_MS },
    );
    if (proc.exitCode !== 0) {
      noteLookupFailure();
      return null;
    }
    const data = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      reviewDecision: string | null;
      statusCheckRollup: GhCheck[] | null;
    };

    const VALID_REVIEW: Set<string> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
    const reviewDecision =
      data.reviewDecision && VALID_REVIEW.has(data.reviewDecision)
        ? (data.reviewDecision as ReviewDecision)
        : null;

    return {
      ciStatus: deriveCiStatus(data.statusCheckRollup ?? []),
      reviewDecision,
    };
  } catch {
    noteLookupFailure();
    return null;
  }
}
