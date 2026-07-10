// Jira project-key allowlist for key extraction. Union of operator-configured
// keys (JIRA_PROJECT_KEYS) and the project keys the sync-jira job has learned
// (jira_issues.project_key). Shared by ingest (session branch extraction) and
// github-app (PR branch/title/body extraction) so both sides filter identically.
import type { PrismaClient } from './generated/client/client';

type AllowlistDb = Pick<PrismaClient, 'jiraIssue'>;

const TTL_MS = 5 * 60_000;

let cache: { fetchedAt: number; keys: string[] } | null = null;

/**
 * Returns the uppercase project-key allowlist, or null when neither source has
 * any keys — callers then accept every key-shaped token (bootstrap mode, the
 * pre-allowlist behaviour). Synced keys are cached in-process for 5 minutes;
 * on a DB error the stale cache (or just the configured keys) is used rather
 * than failing the caller's hot path.
 */
export async function getJiraProjectAllowlist(
  db: AllowlistDb,
  configuredKeys: readonly string[] = [],
): Promise<ReadonlySet<string> | null> {
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > TTL_MS) {
    try {
      const rows = await db.jiraIssue.findMany({
        distinct: ['projectKey'],
        select: { projectKey: true },
        where: { projectKey: { not: null } },
      });
      cache = {
        fetchedAt: now,
        keys: rows.map((r) => r.projectKey as string),
      };
    } catch {
      // Keep any stale cache; a cold cache degrades to the configured keys.
    }
  }

  const union = new Set<string>();
  for (const k of configuredKeys) {
    const key = k.trim().toUpperCase();
    if (key) {
      union.add(key);
    }
  }
  for (const k of cache?.keys ?? []) {
    union.add(k.toUpperCase());
  }
  return union.size > 0 ? union : null;
}

/** Test seam: drop the in-process cache. */
export function resetJiraProjectAllowlistCache(): void {
  cache = null;
}
