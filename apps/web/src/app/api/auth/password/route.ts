import { issueAccessToken, issueRefreshToken, verifyPassword } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ensureVisibilityPolicy } from '@/lib/ensure-visibility-policy';
import { getPrisma } from '@/lib/prisma';
import { sanitizeNext, setAuthCookies } from '@/lib/session-cookie';

const RequestBody = z.object({
  email: z.string().email(),
  next: z.string().optional(),
  password: z.string().min(1).max(1024),
});

// Pre-computed once so every login attempt — including unknown emails — runs the
// full KDF, preventing timing-based email enumeration.
const DUMMY_HASH = await Bun.password.hash('__sentinel__');

const INVALID_CREDENTIALS = 'Invalid email or password';

export async function POST(request: Request) {
  const parsed = RequestBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  const { email, next, password } = parsed.data;

  const db = getPrisma();
  const user = await db.user.findUnique({ where: { email } });

  // Always verify against a hash so response time doesn't reveal whether the email exists.
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || user.deactivatedAt || !valid) {
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
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
}
