/**
 * Best-effort client IP for audit logging. Takes the first hop of
 * `x-forwarded-for` (the original client when behind a trusted proxy), falling
 * back to `x-real-ip`. Returns null when neither is present. Centralized so the
 * audit-log call sites don't each re-implement (and drift on) header parsing.
 */
export function clientIp(headers: Headers): string | null {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return headers.get('x-real-ip');
}
