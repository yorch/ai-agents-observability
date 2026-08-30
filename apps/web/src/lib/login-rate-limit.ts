// Best-effort in-process rate limit for password-based login endpoints.
// Tracks failed attempts per (IP, email) pair in a Map with stale-entry
// eviction. Limits: 5 failed attempts per 15-minute window; the 6th attempt
// within the window gets a 429. Only FAILED attempts are counted — a successful
// login resets the counter for that key.
//
// Tradeoff: this is in-process and per-instance, so multi-instance deployments
// need a shared store (e.g. Redis) for true brute-force protection. The IP
// dimension prevents a single attacker from hammering different accounts; the
// email dimension prevents distributed attacks from overwhelming a single
// account. Together they bound both axes of a credential-stuffing attack.

const WINDOW_MS = 15 * 60 * 1_000;
const MAX_FAILURES = 5;
const MAX_TRACKED = 10_000;

const failures = new Map<string, { count: number; firstTs: number }>();

function evictStale(): void {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of failures) {
    if (entry.firstTs < cutoff) {
      failures.delete(key);
    }
  }
}

function rateKey(ip: string | null, email: string): string {
  return `${ip ?? 'unknown'}:${email.toLowerCase()}`;
}

/**
 * Returns `null` if the request is allowed to proceed, or a `Retry-After` value
 * in seconds if the (IP, email) pair has exceeded the failure threshold.
 */
export function checkLoginRateLimit(ip: string | null, email: string): number | null {
  evictStale();
  if (failures.size >= MAX_TRACKED) {
    evictStale();
  }
  const key = rateKey(ip, email);
  const entry = failures.get(key);
  if (entry && entry.count >= MAX_FAILURES) {
    return Math.ceil((entry.firstTs + WINDOW_MS - Date.now()) / 1_000);
  }
  return null;
}

/**
 * Records a failed login attempt for the (IP, email) pair. Must be called on
 * every authentication failure.
 */
export function recordLoginFailure(ip: string | null, email: string): void {
  const key = rateKey(ip, email);
  const entry = failures.get(key);
  if (entry) {
    entry.count += 1;
  } else {
    failures.set(key, { count: 1, firstTs: Date.now() });
  }
}

/**
 * Resets the failure counter for the (IP, email) pair. Must be called on every
 * successful login.
 */
export function resetLoginRateLimit(ip: string | null, email: string): void {
  failures.delete(rateKey(ip, email));
}

/**
 * Test-only: clears all tracked failures. Not exported from the public API;
 * imported only by test mocks that need to reset state between cases.
 */
export function __clearAll(): void {
  failures.clear();
}
