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

// `EventSchema` fills several fields from `.default()`, so safeParse alone is a
// weaker check than it looks: an event MISSING agent_type validates and silently
// becomes CLAUDE_CODE, which would attribute another agent's telemetry to Claude
// at the data layer. Fields an adapter must stamp itself are checked explicitly,
// before the schema gets a chance to paper over their absence.
const REQUIRED_FIELDS = ['agent_type', 'event_type', 'session_id', 'ts'] as const;

/** Schema violations in an emitted event, as `path: message` strings. Empty = valid. */
export function conformanceErrors(event: unknown): string[] {
  const errors: string[] = [];
  if (typeof event === 'object' && event !== null) {
    const record = event as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (record[field] === undefined) {
        errors.push(`${field}: missing (the schema would silently default it)`);
      }
    }
  }

  const parsed = EventSchema.safeParse(event);
  if (!parsed.success) {
    errors.push(
      ...parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    );
  }
  return errors;
}
