import { Hono } from 'hono';

import type { PriceTableRegistry } from '../lib/price-tables';
import type { AppEnv } from '../types';

export function priceTableRouter(priceTables: PriceTableRegistry): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET /v1/price-table[?agent=<agent_type>]
  // No `agent` param → claude_code default. Unknown agent → 404 (so a client
  // can't silently price against the wrong table).
  router.get('/', (c) => {
    const agent = c.req.query('agent');
    const table = priceTables.forAgentParam(agent);
    if (!table) {
      return c.json({ error: `Unknown agent: ${agent}` }, 404);
    }

    const etag = `"${agent ?? 'claude_code'}:${table.version}"`;
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, {
        headers: { 'Cache-Control': 'public, max-age=3600', ETag: etag },
        status: 304,
      });
    }

    return c.json(table, 200, {
      'Cache-Control': 'public, max-age=3600',
      ETag: etag,
    });
  });

  return router;
}
