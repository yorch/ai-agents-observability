import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { Webhooks } from '@octokit/webhooks';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Config } from '../config';
import { handlePullRequest } from '../handlers/pull-request';
import { recordFailed, recordProcessed, recordReceived } from '../lib/metrics';
import type { AppDb, AppEnv } from '../types';

export function webhooksRouter(db: AppDb, config: Config, logger: Logger): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  const webhooks = new Webhooks({ secret: config.github_app_webhook_secret });

  router.post('/', async (c) => {
    const id = c.req.header('x-github-delivery') ?? 'unknown';
    const event = c.req.header('x-github-event') ?? '';
    const sig = c.req.header('x-hub-signature-256') ?? '';

    if (!sig) {
      return c.json({ error: 'Missing signature' }, 401);
    }
    if (!event) {
      return c.json({ error: 'Missing X-GitHub-Event' }, 400);
    }

    const body = await c.req.text();

    const valid = await webhooks.verify(body, sig);
    if (!valid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const action: string = (payload.action as string) ?? '';
    const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name;

    recordReceived(event);

    // Idempotency + durable record. Persist the delivery keyed by the unique
    // X-GitHub-Delivery id BEFORE acking. GitHub re-delivers on its own schedule,
    // and we ack 202 before processing (so it never retries on our failures);
    // without this, a replay would reprocess (e.g. post a duplicate PR comment)
    // and a failed delivery would leave no trace. A unique-constraint violation
    // means we've already seen this delivery — short-circuit as a duplicate.
    // (If the header is absent — never true for real GitHub — fall back to a
    // random id so a missing header can't collide and block processing.)
    const deliveryId = id === 'unknown' ? `unknown-${crypto.randomUUID()}` : id;
    try {
      await db.webhookDelivery.create({
        data: {
          action: action || null,
          deliveryId,
          eventType: event,
          repo: repoFullName ?? null,
          status: 'received',
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        logger.info({ delivery: deliveryId, event }, 'webhook.duplicate');
        return c.json({ accepted: true, delivery: id, duplicate: true }, 202);
      }
      // DB unavailable — log and still ack so GitHub doesn't hammer retries, but
      // we have no durable record. Surface loudly.
      logger.error({ delivery: deliveryId, err, event }, 'webhook.persist.error');
    }

    const start = Date.now();

    c.status(202);
    const res = c.json({ accepted: true, delivery: id });

    void (async () => {
      try {
        if (event === 'pull_request') {
          await handlePullRequest(
            payload as EmitterWebhookEvent<'pull_request'>['payload'],
            db,
            config,
            logger,
          );
        }
        recordProcessed(`${event}.${action}`, Date.now() - start);
        await db.webhookDelivery
          .update({
            data: { processedAt: new Date(), status: 'processed' },
            where: { deliveryId },
          })
          .catch(() => {});
      } catch (err) {
        recordFailed(`${event}.${action}`);
        logger.error({ delivery: deliveryId, err, event }, 'webhook.handler.error');
        await db.webhookDelivery
          .update({
            data: { errorText: (err as Error).message, processedAt: new Date(), status: 'error' },
            where: { deliveryId },
          })
          .catch(() => {});
      }
    })();

    return res;
  });

  return router;
}
