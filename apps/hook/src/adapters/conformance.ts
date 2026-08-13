import { EventSchema } from '@ai-agents-observability/schemas';

// Shared adapter-test helper (P12-002).
//
// Ingest validates every event individually and DROPS the ones that fail
// (apps/ingest/src/routes/events.ts) — so an adapter that emits a
// nearly-conformant event loses data silently, in production, with a green test
// suite. That is exactly how the opencode `ses_`-prefixed session id survived:
// its test fed a UUID-shaped fixture.
//
// Every adapter test asserts `conformanceErrors(event)` is empty, with a
// REALISTIC native payload — the ids and field spellings the agent actually emits.

/** Schema violations in an emitted event, as `path: message` strings. Empty = valid. */
export function conformanceErrors(event: unknown): string[] {
  const parsed = EventSchema.safeParse(event);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
  );
}
