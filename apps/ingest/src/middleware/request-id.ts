import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../types';

export function requestIdMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const reqId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('requestId', reqId);
    c.header('x-request-id', reqId);
    await next();
  };
}
