import { Webhooks } from '@octokit/webhooks';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { Hono } from 'hono';
import type { Logger } from 'pino';

import { handlePullRequest } from '../handlers/pull-request';
import { recordFailed, recordProcessed, recordReceived } from '../lib/metrics';
import type { Config } from '../config';
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

    recordReceived(event);
    const start = Date.now();

    c.status(202);
    const res = c.json({ accepted: true, delivery: id });

    const payload = JSON.parse(body) as Record<string, unknown>;
    const action: string = (payload.action as string) ?? '';

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
      } catch (err) {
        recordFailed(`${event}.${action}`);
        logger.error({ delivery: id, err, event }, 'webhook.handler.error');
      }
    })();

    return res;
  });

  return router;
}
