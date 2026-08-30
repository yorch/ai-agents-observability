import { createHash, timingSafeEqual } from 'node:crypto';

import type { PrismaClient } from '@ai-agents-observability/db';
import { Hono } from 'hono';
import type { Logger } from 'pino';

import { isKnownJob } from '../jobs/scheduler';
import type { AppEnv } from '../types';

type AdminDb = Pick<PrismaClient, 'auditLog' | 'jobConfig'>;

/**
 * Constant-time string comparison to prevent timing attacks on the admin
 * secret. Both inputs are SHA-256-hashed to a fixed 32-byte length before
 * comparison, so the timing does not leak the length of either input.
 */
function constantTimeCompare(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// Best-effort client IP for audit logging. When trustedProxyCount is set,
// uses the same Nth-from-right logic as the rate limiter. When unset, XFF
// is ignored and x-real-ip is used.
function adminClientIp(
  req: { header: (name: string) => string | undefined },
  trustedProxyCount?: number,
): string {
  if (trustedProxyCount !== undefined && trustedProxyCount > 0) {
    const fwd = req.header('x-forwarded-for');
    if (fwd) {
      const hops = fwd.split(',').map((s) => s.trim());
      const idx = hops.length - trustedProxyCount - 1;
      if (idx >= 0 && hops[idx]) {
        return hops[idx];
      }
    }
  }
  return req.header('x-real-ip') ?? 'unknown';
}

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
  trustedProxyCount?: number,
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
    if (!constantTimeCompare(c.req.header('x-admin-secret') ?? '', adminSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const name = c.req.param('name');

    if (!isKnownJob(name)) {
      return c.json({ error: `Unknown job: ${name}` }, 400);
    }

    try {
      await db.jobConfig.upsert({
        create: {
          // disabled=false so the scheduler's scheduled-run path never fires this
          // row — it only fires via the runRequestedAt manual-trigger path above.
          // Configurable jobs are seeded with enabled=true on startup and always
          // hit the update branch here.
          enabled: false,
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

    // Fire-and-forget audit log — admin actions are operator-level (shared
    // secret, not a user session), so a failed audit write is logged but does
    // not block the action. This is the right trade-off here: unlike the
    // transcript proxy case, there is no cross-user data access to gate on.
    // actorUserId is null (system action, no user session) — the AuditLog
    // table allows null actorUserId for system-generated entries.
    db.auditLog
      .create({
        data: {
          action: 'ADMIN_JOB_TRIGGERED',
          actorUserId: null,
          ip: adminClientIp(c.req, trustedProxyCount),
        },
      })
      .catch((err) => {
        logger?.warn({ err, jobName: name }, 'admin: audit log write failed');
      });

    return c.json({ jobName: name, ok: true });
  });

  return router;
}
