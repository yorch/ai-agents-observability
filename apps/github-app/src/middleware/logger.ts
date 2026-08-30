import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

import type { AppEnv } from '../types';

export function loggerMiddleware(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    const reqId = c.get('requestId');

    logger.debug({ method: c.req.method, path: c.req.path, reqId }, 'req');

    await next();

    const method = c.req.method;
    const path = c.req.path;
    const status = c.res.status;
    if (method !== 'GET' || path !== '/metrics' || status < 200 || status >= 300) {
      logger.info({ duration: Date.now() - start, method, path, reqId, status }, 'res');
    }
  };
}
