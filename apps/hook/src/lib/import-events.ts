import type { Event } from '@ai-agents-observability/schemas';
import type { HookAdapter } from '../adapters';
import { deterministicEventId } from './uuid5';

export type ImportedEventOptions = {
  cwd: string;
  idSeed: string;
  parentEventId?: string | null;
  sessionId: string;
  source: string;
  ts: string | number | null | undefined;
  turnNumber?: number | undefined;
};

export function importedEvent(
  adapter: HookAdapter,
  kind: string,
  raw: Record<string, unknown>,
  options: ImportedEventOptions,
): Event {
  const event = adapter.mapPayload(kind, raw);
  return {
    ...event,
    event_id: deterministicEventId(options.idSeed),
    metadata: { ...event.metadata, imported: true, source: options.source },
    parent_event_id: options.parentEventId ?? null,
    session_context: { ...event.session_context, cwd: options.cwd, git: null },
    session_id: options.sessionId,
    ts: importTimestamp(options.ts),
    turn_number: options.turnNumber,
  } as Event;
}

export function filterImportedEvents(events: Event[], since: Date | null): Event[] {
  if (!since) {
    return events;
  }
  const filtered = events.filter((event) => new Date(event.ts) >= since);
  const emittedIds = new Set(filtered.map((event) => event.event_id));
  return filtered.map((event) => ({
    ...event,
    parent_event_id:
      event.parent_event_id && emittedIds.has(event.parent_event_id) ? event.parent_event_id : null,
  }));
}

export function importTimestamp(value: string | number | null | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 1e11 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    if (!Number.isNaN(millis)) {
      return new Date(millis).toISOString();
    }
  }
  throw new Error('historical event has no valid timestamp');
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
