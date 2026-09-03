/**
 * Parses a `?page=` query param into a usable 1-based page number.
 *
 * Every paginated route needs this and they had each written their own, which
 * is how they came to share two separate bugs:
 *
 * - `Math.max(1, parseInt(raw, 10))` is `NaN` for a non-numeric value, and NaN
 *   propagates into Prisma's `skip` — the list rendered empty with no pager to
 *   escape by.
 * - `Math.max(1, Number(raw) || 1)` fixed that but accepts `1.5` and `1e6`.
 *   A fractional page does NOT throw: Prisma takes the fractional `skip` and
 *   returns a *misaligned slice*. `/me/sessions?page=1.5` returned four
 *   sessions from the middle of the list, presented as a page. Silently wrong
 *   beats loudly broken only if you never read the numbers.
 *
 * A page number is an index into a list, so the only meaningful values are
 * positive safe integers. Everything else — fractions, exponents, Infinity,
 * words, negatives — is not a smaller page or a bigger one, it is not a page,
 * and falls back to the first.
 */
export function parsePageParam(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}
