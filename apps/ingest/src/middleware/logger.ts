import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

import { httpRequestDurationMs, httpRequestsTotal } from '../lib/metrics';
import type { AppEnv } from '../types';

// Single request-observability middleware: it times each request once and emits
// both the structured res log and the Prometheus counter/histogram from that one
// measurement. (Previously a separate timing middleware ran its own Date.now()
// clock, double-measuring every request.)
export function loggerMiddleware(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    const reqId = c.get('requestId');

    logger.debug({ method: c.req.method, path: c.req.path, reqId }, 'req');

    await next();

    const duration = Date.now() - start;
    const method = c.req.method;
    const path = c.req.path;
    // Label with the matched route TEMPLATE so metric cardinality stays bounded
    // (e.g. /v1/events/abc-123 → /v1/events/:id). Unmatched requests — 404s from
    // scanners hitting random URLs — have no template; bucket them under a single
    // constant rather than the raw path, which would be unbounded. The raw path is
    // still captured on the `res` log line below for debugging.
    const route = c.req.routePath ?? 'unmatched';
    const status = c.res.status;

    logger.info({ duration, method, path, reqId, status }, 'res');

    const statusLabel = String(status);
    httpRequestsTotal.inc({ method, route, status: statusLabel });
    httpRequestDurationMs.observe({ method, route, status: statusLabel }, duration);
  };
}
