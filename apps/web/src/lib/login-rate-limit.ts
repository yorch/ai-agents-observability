// Best-effort in-process rate limit for password-based login endpoints.
// Tracks failed attempts per (IP, email) pair in a Map with stale-entry
// eviction. Limits: 5 failed attempts per 15-minute window; the 6th attempt
// within the window gets a 429. Only FAILED attempts are counted — a successful
// login resets the counter for that key.
//
// Tradeoff: this is in-process and per-instance, so multi-instance deployments
// need a shared store (e.g. Redis) for true brute-force protection.
//
// Two counters, deliberately:
//
//   (ip, email) — the narrow one. Catches an ordinary attacker but is only as
//                 trustworthy as the IP, and `clientIp()` reads `X-Real-IP`
//                 verbatim when TRUSTED_PROXY_COUNT is unset — which is the
//                 shipped default, with prod compose publishing web directly.
//                 Rotating one header per request therefore gave a fresh key
//                 every time: measured, 8/8 guesses answered 401 and the
//                 lockout never fired.
//   email        — the one no header can vary. This is what actually bounds
//                 online guessing against a single account.
//
// The file previously claimed the second protection ("the email dimension
// prevents distributed attacks from overwhelming a single account") while
// keying only on the pair, so it did not exist.
//
// The email threshold is deliberately looser than the per-IP one: a strict
// email-only lock lets anyone deny a colleague their login by failing six
// times against their address. This bounds guessing without making lockout
// cheap, and it throttles rather than hard-locks — the window still expires.

const WINDOW_MS = 15 * 60 * 1_000;
const MAX_FAILURES = 5;
/** Ceiling across all source IPs for one account in the window. */
const MAX_FAILURES_PER_EMAIL = 20;
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

/** Key for the per-account counter. The space keeps it clear of rateKey's `ip:email`. */
function emailKey(email: string): string {
  return `email ${email.toLowerCase()}`;
}

function retryAfterFor(key: string, max: number): number | null {
  const entry = failures.get(key);
  if (entry && entry.count >= max) {
    return Math.max(1, Math.ceil((entry.firstTs + WINDOW_MS - Date.now()) / 1_000));
  }
  return null;
}

function bump(key: string): void {
  const entry = failures.get(key);
  if (entry) {
    entry.count += 1;
  } else {
    failures.set(key, { count: 1, firstTs: Date.now() });
  }
}

/**
 * Returns `null` if the request is allowed to proceed, or a `Retry-After` value
 * in seconds if the (IP, email) pair has exceeded the failure threshold.
 */
export function checkLoginRateLimit(ip: string | null, email: string): number | null {
  evictStale();
  if (failures.size >= MAX_TRACKED) {
    // Eviction already ran above, so anything still here is inside the window
    // and cannot be evicted. Drop the oldest instead — repeating evictStale()
    // (what this used to do) is a no-op and left the map growing without bound
    // under a spoofed-IP flood.
    const oldest = [...failures.entries()].sort((a, b) => a[1].firstTs - b[1].firstTs);
    for (const [key] of oldest.slice(0, Math.ceil(MAX_TRACKED / 10))) {
      failures.delete(key);
    }
  }
  // Either dimension can throttle. The per-email one is the load-bearing check
  // when the IP is attacker-controlled.
  return (
    retryAfterFor(rateKey(ip, email), MAX_FAILURES) ??
    retryAfterFor(emailKey(email), MAX_FAILURES_PER_EMAIL)
  );
}

/**
 * Records a failed login attempt for the (IP, email) pair. Must be called on
 * every authentication failure.
 */
export function recordLoginFailure(ip: string | null, email: string): void {
  bump(rateKey(ip, email));
  bump(emailKey(email));
}

/**
 * Resets the failure counter for the (IP, email) pair. Must be called on every
 * successful login.
 */
export function resetLoginRateLimit(ip: string | null, email: string): void {
  failures.delete(rateKey(ip, email));
  // Clear the account counter too: a successful login proves the guesses were
  // not an attack on this account, and leaving it would let a failed burst from
  // elsewhere throttle the legitimate owner.
  failures.delete(emailKey(email));
}

/**
 * Test-only: clears all tracked failures. Not exported from the public API;
 * imported only by test mocks that need to reset state between cases.
 */
export function __clearAll(): void {
  failures.clear();
}
