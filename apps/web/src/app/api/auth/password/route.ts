import { randomUUID } from 'node:crypto';

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
import {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginRateLimit,
} from '@/lib/login-rate-limit';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { clientIp } from '@/lib/request-meta';
import { sanitizeNext, setAuthCookies } from '@/lib/session-cookie';

const RequestBody = z.object({
  email: z.string().email(),
  next: z.string().optional(),
  password: z.string().min(1).max(1024),
});

// Lazily computed on first request so module load doesn't block the build.
//
// The plaintext is random per process, deliberately. It used to be the literal
// '__sentinel__', which made this hash a KNOWN-plaintext target: any code path
// that compared a submitted password against it would authenticate whoever
// typed that string. One did. A random secret means the timing-equalizer can
// never be a credential, whatever a future caller does with it.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomUUID() + randomUUID());
  return dummyHashPromise;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

export const POST = withRouteLogging('auth.password', async (request: Request) => {
  const parsed = RequestBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError('email and password are required', 400);
  }

  const { email, next, password } = parsed.data;

  // Rate-limit check before any DB or hashing work.
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
  // If the user has no password set (a GitHub-OAuth or device-flow account),
  // burn the time and reject — do NOT fall through to verifyPassword with the
  // dummy hash as the comparison target. That hash is `hashPassword(SENTINEL)`,
  // so submitting the sentinel string itself verified TRUE and signed the
  // attacker in as any passwordless user. `/api/auth/token` has always guarded
  // this; this route did not, and the two must not drift again.
  if (!user?.passwordHash) {
    // RUN the comparison, don't merely await the hash. getDummyHash() memoizes,
    // so after the first request `await getDummyHash()` resolves instantly and
    // equalizes nothing: measured, this path answered in ~5ms against ~94ms for
    // an account that has a password — enumerating exactly which emails hold
    // one. verifyPassword against the (random) dummy does the real scrypt work,
    // and cannot succeed because no attacker can know that plaintext.
    await verifyPassword(password, await getDummyHash());
    recordLoginFailure(ip, email);
    logger.warn({ email, reqId: getRequestId() }, 'auth.password.invalid_credentials');
    return jsonError(INVALID_CREDENTIALS, 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (user.deactivatedAt || !valid) {
    recordLoginFailure(ip, email);
    // Never log `password` — `email` is an identifier (not a credential) and is
    // needed to spot brute-force / credential-stuffing attempts against a single account.
    logger.warn({ email, reqId: getRequestId() }, 'auth.password.invalid_credentials');
    return jsonError(INVALID_CREDENTIALS, 401);
  }

  // Successful login resets the counter for this (IP, email) pair.
  resetLoginRateLimit(ip, email);

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
