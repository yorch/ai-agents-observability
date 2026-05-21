import { hashToken } from '@ai-agents-observability/auth';
import type { PrismaClient } from '@ai-agents-observability/db';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

import type { AppEnv } from '../types';

type DbClient = Pick<PrismaClient, 'authToken'>;

type CachedUser = { expiresAt: Date | null; id: string; kind: 'hook' };
type CacheEntry = { expiresAt: number; value: CachedUser };

const TOKEN_CACHE_TTL_MS = 30_000;
const CCT_PREFIX = 'cct_';

class TtlCache {
  private readonly store = new Map<string, CacheEntry>();

  get(key: string): CachedUser | undefined {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: CachedUser): void {
    this.store.set(key, { expiresAt: Date.now() + TOKEN_CACHE_TTL_MS, value });
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}

export function authRequired(db: DbClient, logger: Logger): MiddlewareHandler<AppEnv> {
  const cache = new TtlCache();

  return async (c, next) => {
    const authHeader = c.req.header('authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.slice(7);

    if (!token.startsWith(CCT_PREFIX)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const tokenHash = hashToken(token);
    const now = new Date();

    let user = cache.get(tokenHash);

    if (!user) {
      const record = await db.authToken.findFirst({ where: { tokenHash } });

      if (!record) {
        logger.warn({ reqId: c.get('requestId') }, 'auth: token not found');
        return c.json({ error: 'Unauthorized' }, 401);
      }

      if (record.revokedAt) {
        logger.warn({ reqId: c.get('requestId') }, 'auth: token revoked');
        return c.json({ error: 'Unauthorized' }, 401);
      }

      if (record.expiresAt && record.expiresAt < now) {
        logger.warn({ reqId: c.get('requestId') }, 'auth: token expired');
        return c.json({ error: 'Unauthorized' }, 401);
      }

      if (record.kind !== 'hook') {
        logger.warn({ kind: record.kind, reqId: c.get('requestId') }, 'auth: wrong token kind');
        return c.json({ error: 'Unauthorized' }, 401);
      }

      user = { expiresAt: record.expiresAt, id: record.userId, kind: record.kind };
      // revokedAt is intentionally not cached; revocations take effect within TOKEN_CACHE_TTL_MS.
      cache.set(tokenHash, user);
    } else if (user.expiresAt && user.expiresAt < now) {
      cache.delete(tokenHash);
      logger.warn({ reqId: c.get('requestId') }, 'auth: cached token expired');
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('user', user);
    return await next();
  };
}
