import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

import type { AppEnv } from '../types.js';

export function loggerMiddleware(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    const reqId = c.get('requestId');

    logger.info({ method: c.req.method, path: c.req.path, reqId }, 'req');

    await next();

    logger.info(
      {
        duration: Date.now() - start,
        method: c.req.method,
        path: c.req.path,
        reqId,
        status: c.res.status,
      },
      'res',
    );
  };
}
