import type { PrismaClient } from '@ai-agents-observability/db';
import { Hono } from 'hono';
import type { Logger } from 'pino';

import { isKnownJob } from '../jobs/scheduler';
import type { AppEnv } from '../types';

type AdminDb = Pick<PrismaClient, 'jobConfig'>;

/**
 * Internal admin router for the ingest service.
 *
 * All routes require the `x-admin-secret` header to match the configured
 * ADMIN_SECRET env var.  When no secret is configured, every route returns
 * 404 so the endpoint is not accidentally reachable.
 */
export function adminRouter(
  db: AdminDb,
  adminSecret: string | undefined,
  logger?: Logger,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  /**
   * POST /admin/jobs/:name/run
   *
   * Sets `run_requested_at = NOW()` on the job_config row.  The scheduler
   * polls job_config every 60 s and dispatches the job when it sees a pending
   * runRequestedAt with no matching JobRun started after it.
   *
   * Returns immediately with { ok: true } — the caller must not assume the
   * job has completed.
   *
   * Requires `x-admin-secret` header matching ADMIN_SECRET env var.
   * Returns 404 if secret is unconfigured, 401 if secret is wrong.
   */
  router.post('/jobs/:name/run', async (c) => {
    if (!adminSecret) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (c.req.header('x-admin-secret') !== adminSecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const name = c.req.param('name');

    if (!isKnownJob(name)) {
      return c.json({ error: `Unknown job: ${name}` }, 400);
    }

    try {
      await db.jobConfig.upsert({
        create: {
          // Provide valid defaults so the row satisfies NOT NULL constraints.
          // The nightly scheduler will overwrite these with the real schedule.
          enabled: true,
          jobName: name,
          runHourUtc: 0,
          runMinuteUtc: 0,
          runRequestedAt: new Date(),
        },
        update: { runRequestedAt: new Date() },
        where: { jobName: name },
      });
    } catch (err) {
      logger?.error({ err, jobName: name }, 'admin: failed to set run_requested_at');
      return c.json({ error: 'Internal server error' }, 500);
    }

    return c.json({ jobName: name, ok: true });
  });

  return router;
}
