// Jira project-key allowlist for key extraction. Union of operator-configured
// keys (JIRA_PROJECT_KEYS) and the project keys the sync-jira job has learned
// (jira_issues.project_key). Shared by ingest (session branch extraction) and
// github-app (PR branch/title/body extraction) so both sides filter identically.
import type { PrismaClient } from './generated/client/client';

type AllowlistDb = Pick<PrismaClient, 'jiraIssue'>;

const TTL_MS = 5 * 60_000;

type CacheEntry = { fetchedAt: number; keys: string[] };

// Keyed by client instance so two PrismaClients in one process (replica vs
// primary, test harnesses) never share each other's synced keys.
let cacheByDb = new WeakMap<AllowlistDb, CacheEntry>();

/**
 * Returns the uppercase project-key allowlist, or null when neither source has
 * any keys — callers then accept every key-shaped token (bootstrap mode, the
 * pre-allowlist behaviour). Synced keys are cached in-process for 5 minutes.
 * Failures are negative-cached for the same TTL (keeping any stale keys), so a
 * degraded DB costs at most one extra query per TTL window on the hot paths —
 * never one per request.
 */
export async function getJiraProjectAllowlist(
  db: AllowlistDb,
  configuredKeys: readonly string[] = [],
): Promise<ReadonlySet<string> | null> {
  const now = Date.now();
  let cache = cacheByDb.get(db);
  if (!cache || now - cache.fetchedAt > TTL_MS) {
    try {
      const rows = await db.jiraIssue.findMany({
        distinct: ['projectKey'],
        select: { projectKey: true },
        where: { projectKey: { not: null } },
      });
      cache = { fetchedAt: now, keys: rows.map((r) => r.projectKey as string) };
    } catch {
      // Negative-cache the failure: keep stale keys if we had any, and stamp
      // the TTL either way so the next TTL window retries once, not per call.
      cache = { fetchedAt: now, keys: cache?.keys ?? [] };
    }
    cacheByDb.set(db, cache);
  }

  const union = new Set<string>();
  for (const k of configuredKeys) {
    const key = k.trim().toUpperCase();
    if (key) {
      union.add(key);
    }
  }
  for (const k of cache.keys) {
    union.add(k.toUpperCase());
  }
  return union.size > 0 ? union : null;
}

/** Test seam: drop all cached entries. */
export function resetJiraProjectAllowlistCache(): void {
  cacheByDb = new WeakMap();
}
