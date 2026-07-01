import {
  hashPassword,
  issueAccessToken,
  issueRefreshToken,
  verifyPassword,
} from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { jsonError, withRouteLogging } from '@/lib/api-logging';
import { ensureVisibilityPolicy } from '@/lib/ensure-visibility-policy';
import { logger } from '@/lib/logger';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { sanitizeNext, setAuthCookies } from '@/lib/session-cookie';

const RequestBody = z.object({
  email: z.string().email(),
  next: z.string().optional(),
  password: z.string().min(1).max(1024),
});

// Lazily computed on first request so module load doesn't block the build.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('__sentinel__');
  return dummyHashPromise;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

export const POST = withRouteLogging('auth.password', async (request: Request) => {
  const parsed = RequestBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError('email and password are required', 400);
  }

  const { email, next, password } = parsed.data;

  const db = getPrisma();
  const user = await db.user.findUnique({ where: { email } });

  // Always verify against a hash so response time doesn't reveal whether the email exists.
  const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || user.deactivatedAt || !valid) {
    // Never log `password` — `email` is an identifier (not a credential) and is
    // needed to spot brute-force / credential-stuffing attempts against a single account.
    logger.warn({ email, reqId: getRequestId() }, 'auth.password.invalid_credentials');
    return jsonError(INVALID_CREDENTIALS, 401);
  }

  const [, , access, refresh] = await Promise.all([
    ensureVisibilityPolicy(db, user.id),
    db.user.update({ data: { lastSeenAt: new Date() }, where: { id: user.id } }),
    issueAccessToken(user.id),
    issueRefreshToken(db, user.id),
  ]);

  await setAuthCookies(access, refresh);

  const redirectTo = sanitizeNext(next) ?? '/me';
  return NextResponse.json({ redirect: redirectTo });
});
