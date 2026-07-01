import { NextResponse } from 'next/server';

import { logger } from './logger';
import { getRequestId, runWithRequestContext } from './request-context';

// Wraps a Next.js route handler (any GET/POST/... export, with or without a
// `Request` argument or dynamic-route `params`) with the same request-id +
// structured start/end/error logging that `apps/ingest` and `apps/github-app`
// get for free from their Hono middleware. The web app has no equivalent
// middleware layer for route handlers, so each route opts in by wrapping its
// export: `export const GET = withRouteLogging('me.transcripts', async (req) => ...)`.
export function withRouteLogging<Args extends unknown[]>(
  route: string,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    // Propagate an inbound id (reverse proxy, or a server-to-server caller
    // like apps/ingest) so log lines correlate across services, mirroring
    // apps/ingest and apps/github-app's Hono request-id middleware. Falls
    // back to a fresh id for browser-originated requests and 0-arg handlers.
    const inboundRequestId =
      args[0] instanceof Request ? args[0].headers.get('x-request-id') : null;
    const reqId = inboundRequestId ?? crypto.randomUUID();
    const start = Date.now();

    return runWithRequestContext(reqId, async () => {
      logger.debug({ reqId, route }, 'req');
      try {
        const response = await handler(...args);
        response.headers.set('x-request-id', reqId);
        // `duration` is time-to-response-construction, not time-to-fully-sent:
        // for a route that returns a streamed body (e.g. transcript proxying),
        // this resolves once the stream handle exists, well before the last
        // byte reaches the client.
        logger.info({ duration: Date.now() - start, reqId, route, status: response.status }, 'res');
        return response;
      } catch (err) {
        logger.error({ err, reqId, route }, 'web.unhandled_error');
        const response = jsonError('Internal server error', 500);
        response.headers.set('x-request-id', reqId);
        return response;
      }
    });
  };
}

// Consistent shape for explicitly-handled route errors (401/403/404/502/...),
// so `request_id` is present in the body — not just the `x-request-id`
// response header — everywhere a route rejects a request on purpose.
export function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error, request_id: getRequestId() }, { status });
}
