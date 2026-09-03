import { randomUUID } from 'node:crypto';

import { hashPassword, issueHookToken, verifyPassword } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { jsonError, withRouteLogging } from '@/lib/api-logging';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginRateLimit,
} from '@/lib/login-rate-limit';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { clientIp } from '@/lib/request-meta';

const RequestBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});

// Lazily computed so module load doesn't block the build. Random plaintext per
// process: this hash must never be a known-plaintext target — see the note in
// api/auth/password/route.ts for what happened when it was.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomUUID() + randomUUID());
  return dummyHashPromise;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

function rejectInvalidCredentials(email: string): NextResponse {
  logger.warn({ email, reqId: getRequestId() }, 'auth.token.invalid_credentials');
  return jsonError(INVALID_CREDENTIALS, 401);
}

export const POST = withRouteLogging('auth.token', async (request: Request) => {
  const parsed = RequestBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError('email and password are required', 400);
  }

  const { email, password } = parsed.data;

  // Rate-limit check before any DB or hashing work — same limiter as the
  // dashboard password route, since this endpoint accepts the same credentials.
  const ip = clientIp(request.headers);
  const retryAfter = checkLoginRateLimit(ip, email);
  if (retryAfter !== null) {
    return new NextResponse(
      JSON.stringify({ error: 'Too many failed login attempts. Try again later.' }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(retryAfter, 1)),
        },
        status: 429,
      },
    );
  }

  const db = getPrisma();
  const user = await db.user.findUnique({ where: { email } });

  // Always run a hash so response time doesn't reveal whether the email exists.
  // If the user has no password set (GitHub-only account), burn time with the
  // dummy hash then reject — do NOT fall through to verifyPassword with the
  // sentinel value, which an attacker who knows it could exploit.
  if (!user?.passwordHash) {
    await getDummyHash();
    recordLoginFailure(ip, email);
    return rejectInvalidCredentials(email);
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (user.deactivatedAt || !valid) {
    recordLoginFailure(ip, email);
    return rejectInvalidCredentials(email);
  }

  // Successful login resets the counter for this (IP, email) pair.
  resetLoginRateLimit(ip, email);

  let hookToken: string;
  try {
    const { hookTokenTtlDays } = getConfig();
    hookToken = await issueHookToken(db, user.id, hookTokenTtlDays);
    await Promise.all([
      db.user.update({ data: { lastSeenAt: new Date() }, where: { id: user.id } }),
      db.auditLog.create({
        data: {
          action: 'HOOK_TOKEN_ISSUED',
          actorUserId: user.id,
          ip: clientIp(request.headers),
          justification: 'Password-based hook token issued via CLI',
          targetUserId: user.id,
          userAgent: request.headers.get('user-agent'),
        },
      }),
    ]);
  } catch (err) {
    logger.error({ err, reqId: getRequestId(), userId: user.id }, 'auth.token.issuance_failed');
    return jsonError('Token issuance failed', 500);
  }

  return NextResponse.json({
    display_name: user.displayName ?? user.email ?? email,
    token: hookToken,
  });
});
