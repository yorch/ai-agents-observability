import { verifyAccessToken } from '@ai-agents-observability/auth';
import type { User } from '@ai-agents-observability/db';
import { cookies } from 'next/headers';

import { getPrisma } from './prisma';
import { COOKIE_ACCESS } from './session-cookie';

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_ACCESS)?.value;
  if (!token) {
    return null;
  }

  let userId: string;
  try {
    ({ userId } = await verifyAccessToken(token));
  } catch {
    return null;
  }

  const user = await getPrisma().user.findUnique({ where: { id: userId } });
  if (!user || user.deactivatedAt) {
    return null;
  }
  return user;
}
