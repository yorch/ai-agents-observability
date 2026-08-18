import { getConfig } from './config';

/** Input and output rates per Mtok — what tiering and savings math both need. */
export type ModelRates = { input_per_mtok: number; output_per_mtok: number };

// Server-only helper: fetch the ingest-served price table for one agent. Mirrors
// the fetch the /admin/price-tables page already does. Returns null when
// INGEST_URL is unset or the request fails, so callers degrade to "unpriced"
// rather than erroring — a missing price table must never take a page down.
async function fetchPriceTable(agent: string): Promise<Record<string, Partial<ModelRates>> | null> {
  const { ingestUrl } = getConfig();
  if (!ingestUrl) {
    return null;
  }
  try {
    const res = await fetch(`${ingestUrl}/v1/price-table?agent=${encodeURIComponent(agent)}`, {
      // Prices change at most daily; a short revalidate keeps this off the hot path.
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      prices?: Record<string, Partial<ModelRates>>;
    };
    return body.prices ?? null;
  } catch {
    return null;
  }
}

/**
 * Full per-model rates for one agent. Tiering ranks on a blend of input and
 * output, so both are kept. A row missing either rate is dropped rather than
 * defaulted: a zero rate would rank as the cheapest model available and pull
 * every recommendation toward it.
 */
export async function getModelPrices(
  agent = 'claude_code',
): Promise<Record<string, ModelRates> | null> {
  const prices = await fetchPriceTable(agent);
  if (!prices) {
    return null;
  }
  const out: Record<string, ModelRates> = {};
  for (const [model, price] of Object.entries(prices)) {
    if (typeof price?.input_per_mtok === 'number' && typeof price?.output_per_mtok === 'number') {
      out[model] = { input_per_mtok: price.input_per_mtok, output_per_mtok: price.output_per_mtok };
    }
  }
  return out;
}
