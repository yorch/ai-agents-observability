import type { DevicePollResult } from '@ai-agents-observability/auth';
import { issueHookToken, pollDeviceFlow } from '@ai-agents-observability/auth';
import { createGitHubClient } from '@ai-agents-observability/github';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { jsonError, withRouteLogging } from '@/lib/api-logging';
import { getConfig } from '@/lib/config';
import { ensureVisibilityPolicy } from '@/lib/ensure-visibility-policy';
import { logger } from '@/lib/logger';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { clientIp } from '@/lib/request-meta';

const PollBody = z.object({ device_code: z.string().min(1) });

// GitHub device codes expire after ~15 minutes
const DEVICE_CODE_TTL_MS = 15 * 60 * 1_000;
const MIN_INTERVAL_MS = 5_000;

// Best-effort in-process rate limit. In multi-instance deployments each instance
// has its own map, so this only prevents rapid polling within a single instance.
const pollTimestamps = new Map<string, number>();

function evictStale(): void {
  const cutoff = Date.now() - DEVICE_CODE_TTL_MS;
  for (const [key, ts] of pollTimestamps) {
    if (ts < cutoff) {
      pollTimestamps.delete(key);
    }
  }
}

export const POST = withRouteLogging('auth.device.poll', async (request: Request) => {
  const body = PollBody.safeParse(await request.json().catch(() => ({})));
  if (!body.success) {
    return jsonError('Invalid request', 400);
  }

  const { device_code } = body.data;

  evictStale();
  const last = pollTimestamps.get(device_code) ?? 0;
  if (Date.now() - last < MIN_INTERVAL_MS) {
    return NextResponse.json({ status: 'pending' });
  }
  pollTimestamps.set(device_code, Date.now());

  const { githubOAuthClientId: clientId, githubOAuthClientSecret: clientSecret } = getConfig();
  if (!clientId || !clientSecret) {
    return jsonError('OAuth not configured', 503);
  }

  let pollResult: DevicePollResult;
  try {
    pollResult = await pollDeviceFlow(clientId, clientSecret, device_code);
  } catch (err) {
    logger.error({ err, reqId: getRequestId() }, 'auth.device.poll_failed');
    return jsonError('Poll failed', 502);
  }

  if (pollResult.status === 'pending') {
    // Relay GitHub's slow_down so the CLI widens its polling interval.
    return NextResponse.json(
      pollResult.slowDown
        ? { interval: pollResult.interval, slow_down: true, status: 'pending' }
        : { status: 'pending' },
    );
  }

  const ghClient = createGitHubClient({ token: pollResult.access_token });
  let ghUser: Awaited<ReturnType<typeof ghClient.rest.users.getAuthenticated>>['data'];
  try {
    ({ data: ghUser } = await ghClient.rest.users.getAuthenticated());
  } catch (err) {
    logger.error({ err, reqId: getRequestId() }, 'auth.device.fetch_github_user_failed');
    return jsonError('Failed to fetch GitHub user', 502);
  }

  // Single-org enforcement (opt-in). Without this gate, anyone with a GitHub
  // account who completes the device flow can mint a 365-day hook token and
  // start ingesting. When GITHUB_ALLOWED_ORG is set, require membership first.
  const { githubAllowedOrg: allowedOrg } = getConfig();
  if (allowedOrg) {
    try {
      const { data: orgs } = await ghClient.rest.orgs.listForAuthenticatedUser({ per_page: 100 });
      const isMember = orgs.some((o) => o.login.toLowerCase() === allowedOrg.toLowerCase());
      if (!isMember) {
        logger.warn(
          { githubLogin: ghUser.login, reqId: getRequestId() },
          'auth.device.not_org_member',
        );
        return jsonError('Not a member of the authorized organization', 403);
      }
    } catch (err) {
      logger.error({ err, reqId: getRequestId() }, 'auth.device.org_membership_check_failed');
      return jsonError('Failed to verify organization membership', 502);
    }
  }

  let hookToken: string;
  try {
    const db = getPrisma();
    const user = await db.user.upsert({
      create: {
        displayName: ghUser.name ?? ghUser.login,
        email: ghUser.email ?? null,
        githubId: BigInt(ghUser.id),
        githubLogin: ghUser.login,
        lastSeenAt: new Date(),
      },
      update: { lastSeenAt: new Date() },
      where: { githubId: BigInt(ghUser.id) },
    });

    await ensureVisibilityPolicy(db, user.id);
    hookToken = await issueHookToken(db, user.id);

    await db.auditLog.create({
      data: {
        action: 'HOOK_TOKEN_ISSUED',
        actorUserId: user.id,
        ip: clientIp(request.headers),
        justification: 'Device-code hook token issued',
        targetUserId: user.id,
        userAgent: request.headers.get('user-agent'),
      },
    });
  } catch (err) {
    logger.error({ err, reqId: getRequestId() }, 'auth.device.token_issuance_failed');
    return jsonError('Token issuance failed', 500);
  }

  pollTimestamps.delete(device_code);
  return NextResponse.json({
    github_login: ghUser.login,
    hook_token: hookToken,
    status: 'authorized',
  });
});
