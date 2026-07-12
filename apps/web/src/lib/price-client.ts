import type { ModelInputPrice } from '@/lib/routing-queries';
import { getConfig } from './config';

// Server-only helper: fetch the ingest-served price table and reduce it to the
// per-model input rate the routing-savings estimate needs. Mirrors the fetch the
// /admin/price-tables page already does. Returns null when INGEST_URL is unset or
// the request fails, so callers fall back to the flat heuristic rather than erroring.
export async function getModelInputPrices(
  agent = 'claude_code',
): Promise<Record<string, ModelInputPrice> | null> {
  const { ingestUrl } = getConfig();
  if (!ingestUrl) {
    return null;
  }
  try {
    const res = await fetch(`${ingestUrl}/v1/price-table?agent=${agent}`, {
      // Prices change at most daily; a short revalidate keeps this off the hot path.
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      prices?: Record<string, { input_per_mtok?: number }>;
    };
    if (!body.prices) {
      return null;
    }
    const out: Record<string, ModelInputPrice> = {};
    for (const [model, price] of Object.entries(body.prices)) {
      if (typeof price?.input_per_mtok === 'number') {
        out[model] = { input_per_mtok: price.input_per_mtok };
      }
    }
    return out;
  } catch {
    return null;
  }
}
