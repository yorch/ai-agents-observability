import { isUniqueViolation } from '@ai-agents-observability/db';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { Webhooks } from '@octokit/webhooks';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';
import type { Config } from '../config';
import { type CheckRunPayload, handleCheckRun } from '../handlers/check-run';
import { handlePullRequest } from '../handlers/pull-request';
import { handlePullRequestReview } from '../handlers/pull-request-review';
import { handlePush, type PushPayload } from '../handlers/push';
import { recordFailed, recordProcessed, recordReceived } from '../lib/metrics';
import {
  CheckRunPayloadSchema,
  PullRequestPayloadSchema,
  PullRequestReviewPayloadSchema,
  PushPayloadSchema,
} from '../lib/webhook-payloads';
import type { AppDb, AppEnv } from '../types';

/**
 * GitHub documents 25 MB as the ceiling for a webhook payload and does not
 * deliver above it, so anything larger is not from GitHub.
 *
 * The limit has to sit in front of the handler rather than inside it, because
 * the handler reads the whole body with `c.req.text()` *before* it can verify
 * the signature — the HMAC is over the body, so there is no way to authenticate
 * first. That makes this route the one place in the system where an
 * unauthenticated caller decides how much memory we allocate. `apps/ingest`
 * already wraps both of its *authenticated* routes in `bodyLimit`; the
 * unauthenticated one had neither that nor a rate limit.
 */
const MAX_BODY_BYTES = 25 * 1_048_576; // 25 MB

export function webhooksRouter(db: AppDb, config: Config, logger: Logger): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  const webhooks = new Webhooks({ secret: config.github_app_webhook_secret });

  router.post(
    '/',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => {
        logger.warn({ size_limit_bytes: MAX_BODY_BYTES }, 'github_app.webhook.body_too_large');
        return c.json({ error: 'Request body too large' }, 413);
      },
    }),
    async (c) => {
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
      // X-GitHub-Delivery id BEFORE acking. A unique-constraint violation means
      // we've already seen this delivery — short-circuit as a duplicate.
      //
      // DELIVERY IS AT-MOST-ONCE, DELIBERATELY. We ack 202 before processing, and
      // GitHub only retries non-2xx, so it will never redeliver — that is the
      // point: a handler failure must not make GitHub resend and post a duplicate
      // PR comment. The cost is that a process death between this row and handler
      // completion loses the event outright, and the row is the only trace.
      //
      // This row is therefore a RECORD, not a recovery mechanism. Nothing
      // reprocesses it. `jobs/sweep-stale-deliveries.ts` exists so that loss is at
      // least visible rather than silent; read its header before assuming a
      // `received` row will be retried.
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
          // Parse, don't cast. `X-GitHub-Event` picks the handler and is NOT
          // covered by the signature (the HMAC is over the body alone), so the
          // body/handler pairing is attacker-controlled. A cast asserts a shape
          // nothing checks; the first evidence of a mismatch used to be a
          // TypeError thrown inside this detached block. `parsed()` returns null
          // and logs instead, so a mis-routed body is a no-op rather than a
          // crash. Schemas are minimal and loose on purpose — see
          // lib/webhook-payloads.ts.
          function parsed<T>(schema: {
            safeParse: (v: unknown) => { data?: T; success: boolean };
          }) {
            const result = schema.safeParse(payload);
            if (!result.success) {
              logger.warn({ delivery: deliveryId, event }, 'webhook.payload.schema_mismatch');
              return null;
            }
            return result.data as T;
          }

          if (event === 'pull_request') {
            const p = parsed(PullRequestPayloadSchema);
            if (p) {
              await handlePullRequest(
                p as unknown as EmitterWebhookEvent<'pull_request'>['payload'],
                db,
                config,
                logger,
              );
            }
          }

          // P5-005: GitHub Checks correlation — per-run outcome rows + the
          // failure counter on rollups.
          if (event === 'check_run') {
            const p = parsed(CheckRunPayloadSchema);
            if (p) {
              await handleCheckRun(p as CheckRunPayload, db, logger);
            }
          }

          // Submitted/dismissed reviews → pr_reviews + maintained review_count.
          if (event === 'pull_request_review') {
            const p = parsed(PullRequestReviewPayloadSchema);
            if (p) {
              await handlePullRequestReview(
                p as unknown as EmitterWebhookEvent<'pull_request_review'>['payload'],
                db,
                config,
                logger,
              );
            }
          }

          // Default-branch pushes → commit→session correlation (DESIGN_DOC §7.2).
          if (event === 'push') {
            const p = parsed(PushPayloadSchema);
            if (p) {
              await handlePush(p as PushPayload, db, config, logger);
            }
          }
          recordProcessed(`${event}.${action}`, Date.now() - start);
          await db.webhookDelivery
            .update({
              data: { processedAt: new Date(), status: 'processed' },
              where: { deliveryId },
            })
            // A swallowed failure here leaves a SUCCEEDED delivery recorded as
            // `received`, which is the same thing an abandoned one looks like.
            // That makes `status` unable to tell loss from a bookkeeping miss —
            // and the stale-delivery sweep reads exactly that field. Still
            // non-fatal (the work is done; only the record is wrong), but it has
            // to be visible or the sweep reports phantoms and gets ignored.
            .catch((err: unknown) => {
              logger.error(
                { delivery: deliveryId, err, event },
                'webhook.delivery.mark_processed_failed',
              );
            });
        } catch (err) {
          recordFailed(`${event}.${action}`);
          logger.error({ delivery: deliveryId, err, event }, 'webhook.handler.error');
          await db.webhookDelivery
            .update({
              data: { errorText: (err as Error).message, processedAt: new Date(), status: 'error' },
              where: { deliveryId },
            })
            .catch((err2: unknown) => {
              // Same reasoning as above: without this the row keeps saying
              // `received` and the failure is invisible twice over.
              logger.error(
                { delivery: deliveryId, err: err2, event },
                'webhook.delivery.mark_error_failed',
              );
            });
        }
      })();

      return res;
    },
  );

  return router;
}
