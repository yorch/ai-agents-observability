import { EventsBatchSchema } from '@ai-agents-observability/schemas';
import type { PriceTable } from '@ai-agents-observability/schemas';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Logger } from 'pino';

import { verifyIdentityClaim } from '../lib/identity.js';
import { insertEventsBatch } from '../lib/insert-events.js';
import type { AppEnv, EventsDb } from '../types.js';

export function eventsRouter(db: EventsDb, priceTable: PriceTable, logger: Logger): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post(
    '/',
    zValidator('json', EventsBatchSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: 'Validation error', issues: result.error.issues }, 400);
      }
    }),
    async (c) => {
      const batch = c.req.valid('json');

      if (batch.events.length > 500) {
        return c.json({ error: 'Batch exceeds 500 events' }, 413);
      }

      const userId = verifyIdentityClaim(c, batch.events[0]?.user_id_claim, logger);

      const git = batch.session_context.git;
      if (git?.owner && git?.repo) {
        await db.repo.upsert({
          where: { githubOwner_githubName: { githubOwner: git.owner, githubName: git.repo } },
          create: { githubOwner: git.owner, githubName: git.repo },
          update: {},
        });
      }

      const reqId = c.get('requestId');
      const start = Date.now();

      const result = await insertEventsBatch(db, batch.events, userId, priceTable);

      logger.info(
        {
          accepted: result.accepted,
          deduped: result.deduped,
          duration_ms: Date.now() - start,
          reqId,
        },
        'ingest.events.accepted',
      );

      return c.json({ accepted: result.accepted, deduped: result.deduped, request_id: reqId }, 202);
    },
  );

  return router;
}
