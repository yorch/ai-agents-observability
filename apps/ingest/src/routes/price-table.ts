import { PriceTableSchema } from '@ai-agents-observability/schemas';
import { Hono } from 'hono';

import type { AppEnv } from '../types.js';
import rawPriceTable from '../data/price-table.v1.json' with { type: 'json' };

const priceTable = PriceTableSchema.parse(rawPriceTable);
const etag = `"${priceTable.version}"`;

export function priceTableRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', (c) => {
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304 });
    }

    return c.json(priceTable, 200, {
      'Cache-Control': 'public, max-age=3600',
      ETag: etag,
    });
  });

  return router;
}
