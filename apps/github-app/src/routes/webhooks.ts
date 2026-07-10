import { isUniqueViolation } from '@ai-agents-observability/db';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { Webhooks } from '@octokit/webhooks';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Config } from '../config';
import { type CheckRunPayload, handleCheckRun } from '../handlers/check-run';
import { handlePullRequest } from '../handlers/pull-request';
import { handlePullRequestReview } from '../handlers/pull-request-review';
import { handlePush, type PushPayload } from '../handlers/push';
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
      if (isUniqueViolation(err)) {
        logger.info({ delivery: deliveryId, event }, 'webhook.duplicate');
        return c.json({ accepted: true, delivery: id, duplicate: true }, 202);
      }
      // DB unavailable (non-unique error): we cannot record the delivery, so we
      // cannot guarantee exactly-once processing. Do NOT process+ack — return 503
      // so GitHub redelivers later; when the DB recovers, the redelivery creates
      // the row and processes exactly once. Processing here would risk duplicate
      // side effects (e.g. a second PR comment) with no dedup record.
      logger.error({ delivery: deliveryId, err, event }, 'webhook.persist.error');
      return c.json({ error: 'Storage unavailable, retry later' }, 503);
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

        // P5-005: GitHub Checks correlation — per-run outcome rows + the
        // failure counter on rollups.
        if (event === 'check_run') {
          await handleCheckRun(payload as CheckRunPayload, db, logger);
        }

        // Submitted/dismissed reviews → pr_reviews + maintained review_count.
        if (event === 'pull_request_review') {
          await handlePullRequestReview(
            payload as EmitterWebhookEvent<'pull_request_review'>['payload'],
            db,
            logger,
          );
        }

        // Default-branch pushes → commit→session correlation (DESIGN_DOC §7.2).
        if (event === 'push') {
          await handlePush(payload as PushPayload, db, config, logger);
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
