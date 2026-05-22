import type { PriceTable } from '@ai-agents-observability/schemas';
import { Hono } from 'hono';

import type { AppEnv } from '../types';

export function priceTableRouter(priceTable: PriceTable): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const etag = `"${priceTable.version}"`;

  router.get('/', (c) => {
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, {
        headers: { 'Cache-Control': 'public, max-age=3600', ETag: etag },
        status: 304,
      });
    }

    return c.json(priceTable, 200, {
      'Cache-Control': 'public, max-age=3600',
      ETag: etag,
    });
  });

  return router;
}
