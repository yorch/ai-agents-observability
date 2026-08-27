// Payload-reading primitives shared by every adapter.
//
// Each agent spells its fields differently, so adapters all need "the first
// usable value among these keys". That loop was written four times across the
// adapters with two DIFFERENT answers to whether an empty string counts —
// which is a real semantic split hiding in code that reads as interchangeable.
// One definition lives here so it cannot drift again.

/** True for a non-null object (arrays included — use `isPlainRecord` to exclude them). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True for a non-null, non-array object. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

/** First non-empty string among `keys`, else null. */
export function pickString(raw: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * First USABLE value among `keys`, else null — `undefined`, `null` and `''` are
 * skipped rather than accepted.
 *
 * The empty-string skip is the load-bearing part: taking the first merely-present
 * value lets `{ sessionId: "", session_id: "real-id" }` collapse to the nil
 * session UUID, merging unrelated events into one phantom session.
 */
export function pickValue(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

/**
 * A non-negative integer duration, or null when `value` is missing or not a
 * usable number (P14-010).
 *
 * Distinct from the `num()` helpers scattered across the adapters: those
 * default an absent/malformed field to 0, which is correct for a token count
 * (no tokens really is 0) but wrong for a duration a vendor's hook payload
 * never measured — 0 there reads as "instant", not "unknown", and pollutes
 * every AVG/percentile downstream. Absence must stay absent.
 */
export function optionalNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}
