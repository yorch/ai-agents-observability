// Exponential backoff with ±20% jitter.

const BASE_MS = 1_000;
const MAX_MS = 300_000;
const JITTER_FACTOR = 0.2;

/**
 * Returns delay in ms.
 * attempt=0 → ~1000ms, doubles each time, caps at 300_000ms.
 * Jitter is ±20% of the computed delay.
 */
export function backoffMs(attempt: number): number {
  const base = Math.min(BASE_MS * 2 ** attempt, MAX_MS);
  const jitter = base * JITTER_FACTOR * (2 * Math.random() - 1);
  return Math.round(base + jitter);
}

/** Sleep for backoffMs(attempt) milliseconds. */
export async function backoffSleep(attempt: number): Promise<void> {
  await Bun.sleep(backoffMs(attempt));
}
