import { issueAccessToken, issueRefreshToken, verifyPassword } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

import { ensureVisibilityPolicy } from '@/lib/ensure-visibility-policy';
import { getPrisma } from '@/lib/prisma';
import { sanitizeNext, setAuthCookies } from '@/lib/session-cookie';

const INVALID_CREDENTIALS = 'Invalid email or password';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).email !== 'string' ||
    typeof (body as Record<string, unknown>).password !== 'string'
  ) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  const { email, next, password } = body as { email: string; next?: unknown; password: string };

  const db = getPrisma();
  const user = await db.user.findFirst({
    where: { email, deactivatedAt: null, passwordHash: { not: null } },
  });

  // Always run verifyPassword to prevent timing-based email enumeration.
  const DUMMY_HASH =
    '$argon2id$v=19$m=65536,t=2,p=1$dummydummydummy$dummydummydummydummydummydummydummydummydummy';
  const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
  const valid = await verifyPassword(password, hashToCheck);

  if (!user || !valid) {
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
  }

  await ensureVisibilityPolicy(db, user.id);
  await db.user.update({ data: { lastSeenAt: new Date() }, where: { id: user.id } });

  const [access, refresh] = await Promise.all([
    issueAccessToken(user.id),
    issueRefreshToken(db, user.id),
  ]);

  await setAuthCookies(access, refresh);

  const redirectTo = sanitizeNext(typeof next === 'string' ? next : null) ?? '/me';
  return NextResponse.json({ redirect: redirectTo });
}
