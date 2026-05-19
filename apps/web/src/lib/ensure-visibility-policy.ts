import type { PrismaClient } from '@ai-agents-observability/db';

type Db = Pick<PrismaClient, 'visibilityPolicy'>;

export async function ensureVisibilityPolicy(db: Db, userId: string): Promise<void> {
  await db.visibilityPolicy.upsert({
    create: { userId },
    update: {},
    where: { userId },
  });
}
