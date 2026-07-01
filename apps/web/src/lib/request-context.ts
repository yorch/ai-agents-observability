import { AsyncLocalStorage } from 'node:async_hooks';

// Makes the current request's ID available to any code running inside a
// `withRouteLogging`-wrapped handler (route handlers, and anything they call),
// without threading it through every function signature — mirrors how
// `apps/ingest` and `apps/github-app` attach `reqId` via Hono's context.
const storage = new AsyncLocalStorage<{ reqId: string }>();

export function runWithRequestContext<T>(reqId: string, fn: () => T): T {
  return storage.run({ reqId }, fn);
}

// Falls back to a fresh id (not a shared "unknown" literal) when called
// outside a `withRouteLogging`-wrapped context — e.g. from a Server
// Component or Server Action, which have no equivalent wrapper today. A
// shared constant would make unrelated log lines from different requests
// indistinguishable from one another; a fresh id per call at least keeps
// them individually traceable.
export function getRequestId(): string {
  return storage.getStore()?.reqId ?? crypto.randomUUID();
}
