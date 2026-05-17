import type { DevicePollResult } from '@ai-agents-observability/auth';
import { issueHookToken, pollDeviceFlow } from '@ai-agents-observability/auth';
import { createClient } from '@ai-agents-observability/db';
import { createGitHubClient } from '@ai-agents-observability/github';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureVisibilityPolicy } from '../../../../../lib/ensure-visibility-policy.js';
import { requireEnv } from '../../../../../lib/env.js';

const db = createClient(requireEnv('DATABASE_URL'));

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

export async function POST(request: Request) {
  const body = PollBody.safeParse(await request.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { device_code } = body.data;

  evictStale();
  const last = pollTimestamps.get(device_code) ?? 0;
  if (Date.now() - last < MIN_INTERVAL_MS) {
    return NextResponse.json({ status: 'pending' });
  }
  pollTimestamps.set(device_code, Date.now());

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'OAuth not configured' }, { status: 503 });
  }

  let pollResult: DevicePollResult;
  try {
    pollResult = await pollDeviceFlow(clientId, clientSecret, device_code);
  } catch {
    return NextResponse.json({ error: 'Poll failed' }, { status: 502 });
  }

  if (pollResult.status === 'pending') {
    return NextResponse.json({ status: 'pending' });
  }

  const ghClient = createGitHubClient({ token: pollResult.access_token });
  const { data: ghUser } = await ghClient.rest.users.getAuthenticated();

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

  const hookToken = await issueHookToken(db, user.id);

  await db.auditLog.create({
    data: {
      action: 'view_session', // placeholder — Phase 3 adds hook_token_issued to AuditAction
      actorUserId: user.id,
      justification: 'Device-code hook token issued',
      targetUserId: user.id,
    },
  });

  pollTimestamps.delete(device_code);
  return NextResponse.json({ hook_token: hookToken, status: 'authorized' });
}
