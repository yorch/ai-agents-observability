import { issueHookToken, pollDeviceFlow } from '@ai-agents-observability/auth';
import { createClient } from '@ai-agents-observability/db';
import { createGitHubClient } from '@ai-agents-observability/github';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const db = createClient(process.env.DATABASE_URL!);

const PollBody = z.object({ device_code: z.string().min(1) });

// Minimum interval between poll calls per device_code (GitHub requires ≥5s by default)
const pollTimestamps = new Map<string, number>();
const MIN_INTERVAL_MS = 5_000;

export async function POST(request: Request) {
  const body = PollBody.safeParse(await request.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { device_code } = body.data;

  // Rate limit
  const last = pollTimestamps.get(device_code) ?? 0;
  if (Date.now() - last < MIN_INTERVAL_MS) {
    return NextResponse.json({ status: 'pending' });
  }
  pollTimestamps.set(device_code, Date.now());

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET!;

  let pollResult;
  try {
    pollResult = await pollDeviceFlow(clientId, clientSecret, device_code);
  } catch {
    return NextResponse.json({ error: 'Poll failed' }, { status: 502 });
  }

  if (pollResult.status === 'pending') {
    return NextResponse.json({ status: 'pending' });
  }

  // Authorized — fetch user and issue hook token
  const ghClient = createGitHubClient({ token: pollResult.access_token });
  const { data: ghUser } = await ghClient.rest.users.getAuthenticated();

  const user = await db.user.upsert({
    where: { githubId: BigInt(ghUser.id) },
    create: {
      githubLogin: ghUser.login,
      githubId: BigInt(ghUser.id),
      email: ghUser.email ?? null,
      displayName: ghUser.name ?? ghUser.login,
      lastSeenAt: new Date(),
    },
    update: { lastSeenAt: new Date() },
  });

  // Ensure VisibilityPolicy
  await db.visibilityPolicy.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
  });

  const hookToken = await issueHookToken(db, user.id);

  await db.auditLog.create({
    data: {
      actorUserId: user.id,
      action: 'view_session', // Closest available; Phase 3 will add hook_token_issued
      targetUserId: user.id,
      justification: 'Device-code hook token issued',
    },
  });

  pollTimestamps.delete(device_code);

  return NextResponse.json({ status: 'authorized', hook_token: hookToken });
}
