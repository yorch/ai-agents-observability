import { getConfig } from './config';

/**
 * Best-effort client IP for audit logging. When `trustedProxyCount` is
 * configured (via TRUSTED_PROXY_COUNT env var), takes the Nth-from-right entry
 * of `x-forwarded-for` (the original client behind N trusted proxies). When
 * unset or 0, `X-Forwarded-For` is ignored entirely (it is client-controlled
 * and spoofable) and we fall back to `x-real-ip` (set by the trusted proxy) or
 * null. This mirrors the ingest rate limiter's behavior.
 */
export function clientIp(headers: Headers, trustedProxyCount?: number): string | null {
  // Read trustedProxyCount from the explicit parameter, or from config.
  // getConfig() can throw during tests when env vars are not set; treat that
  // as "unconfigured" (ignore XFF).
  let count = trustedProxyCount;
  if (count === undefined) {
    try {
      count = getConfig().trustedProxyCount;
    } catch {
      // Config not available — treat as unconfigured.
    }
  }

  if (count !== undefined && count > 0) {
    const fwd = headers.get('x-forwarded-for');
    if (fwd) {
      const hops = fwd.split(',').map((s) => s.trim());
      // Nth-from-right: with 1 trusted proxy, "client, proxy" → hops[0].
      const idx = hops.length - count - 1;
      if (idx >= 0 && hops[idx]) {
        return hops[idx];
      }
    }
  }

  // When TRUSTED_PROXY_COUNT is unset/0, XFF is client-controlled and must not
  // be trusted. Fall back to x-real-ip (set by the reverse proxy) or null.
  return headers.get('x-real-ip');
}
