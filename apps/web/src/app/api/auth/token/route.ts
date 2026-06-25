import { hashPassword, issueHookToken, verifyPassword } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getPrisma } from '@/lib/prisma';
import { clientIp } from '@/lib/request-meta';

const RequestBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});

// Lazily computed so module load doesn't block the build.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('__sentinel__');
  return dummyHashPromise;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

export async function POST(request: Request) {
  const parsed = RequestBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  const { email, password } = parsed.data;
  const db = getPrisma();
  const user = await db.user.findUnique({ where: { email } });

  // Always verify against a hash so response time doesn't reveal whether the email exists.
  const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || user.deactivatedAt || !valid) {
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
  }

  let hookToken: string;
  try {
    hookToken = await issueHookToken(db, user.id);
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
  } catch {
    return NextResponse.json({ error: 'Token issuance failed' }, { status: 500 });
  }

  return NextResponse.json({
    display_name: user.displayName ?? user.email ?? email,
    token: hookToken,
  });
}
