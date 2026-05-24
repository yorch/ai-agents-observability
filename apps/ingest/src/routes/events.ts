import type { PriceTable } from '@ai-agents-observability/schemas';
import { EventsBatchSchema } from '@ai-agents-observability/schemas';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';

import { verifyIdentityClaim } from '../lib/identity';
import { insertEventsBatch } from '../lib/insert-events';
import { linkSessionToPR } from '../lib/session-pr-link';
import { upsertSessions } from '../lib/upsert-session';
import type { AppEnv, EventsDb } from '../types';

const MAX_BODY_BYTES = 1_048_576; // 1 MB

export function eventsRouter(db: EventsDb, priceTable: PriceTable, logger: Logger): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post(
    '/',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'Request body too large' }, 413),
    }),
    zValidator('json', EventsBatchSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: 'Validation error', issues: result.error.issues }, 400);
      }
      return;
    }),
    async (c) => {
      const batch = c.req.valid('json');

      if (batch.events.length > 500) {
        return c.json({ error: 'Batch exceeds 500 events' }, 413);
      }

      const userId = verifyIdentityClaim(c, batch.events[0]?.user_id_claim, logger);

      // Upsert every distinct (owner, repo) we see across events. A batch can
      // legitimately span repos when the hook flushes a queue mid-cwd-change.
      const repoKeys = new Set<string>();
      for (const ev of batch.events) {
        const git = ev.session_context.git;
        if (git?.owner && git?.repo) {
          repoKeys.add(`${git.owner}/${git.repo}`);
        }
      }
      const topGit = batch.session_context.git;
      if (topGit?.owner && topGit?.repo) {
        repoKeys.add(`${topGit.owner}/${topGit.repo}`);
      }
      const repoIdByKey = new Map<string, string>();
      for (const key of repoKeys) {
        const [owner, name] = key.split('/', 2) as [string, string];
        const row = await db.repo.upsert({
          create: { githubName: name, githubOwner: owner },
          update: {},
          where: { githubOwner_githubName: { githubName: name, githubOwner: owner } },
        });
        repoIdByKey.set(key, row.id);
      }

      const reqId = c.get('requestId');
      const start = Date.now();

      const inserted = await insertEventsBatch(db, batch.events, userId, priceTable);

      // Only feed newly-inserted events into the per-session accumulator.
      // Retries replay event_ids that ON CONFLICT DO NOTHING already swallowed;
      // if we re-aggregated those, tokens / cost / tool counts on the session
      // row would inflate on every retry with no way to self-correct.
      const acceptedEvents = batch.events.filter((e) => inserted.acceptedEventIds.has(e.event_id));
      const aggregated = await upsertSessions(
        db,
        acceptedEvents,
        userId,
        repoIdByKey,
        priceTable,
        topGit,
      );

      // Best-effort session→PR linking (P2-004). Fire-and-forget; errors don't fail the request.
      Promise.allSettled(
        acceptedEvents
          .filter((e) => e.session_context.git?.pr_number != null)
          .map((e) => {
            const git = e.session_context.git;
            if (!git || !git.owner || !git.repo || git.pr_number == null) {
              return Promise.resolve();
            }
            const key = `${git.owner}/${git.repo}`;
            const repoId = repoIdByKey.get(key);
            if (!repoId) {
              return Promise.resolve();
            }
            return linkSessionToPR(db, e.session_id, repoId, git.pr_number);
          }),
      ).catch(() => {});

      logger.info(
        {
          accepted: inserted.accepted,
          deduped: inserted.deduped,
          duration_ms: Date.now() - start,
          reqId,
          sessions_touched: aggregated.sessionsTouched,
        },
        'ingest.events.accepted',
      );

      return c.json(
        {
          accepted: inserted.accepted,
          deduped: inserted.deduped,
          request_id: reqId,
          sessions_touched: aggregated.sessionsTouched,
        },
        202,
      );
    },
  );

  return router;
}
