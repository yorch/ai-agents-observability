import { describe, expect, it } from 'bun:test';

import type { ConformantEvent, HookAdapter } from './adapters';
import { eventsFor } from './hook-entry';

// The `mapBatch` → [] contract (P12-005).
//
// Gemini's AfterModel hook is harvested for token usage and emits NO event, which
// works only because the batch is combined with `??` — `[] ?? [mapPayload(...)]`
// is `[]`. With `||` the empty array would fall through and mapPayload would
// fabricate a Notification for every LLM call, silently, in production. That one
// character has no other guard, so it gets its own test.

const EVENT = { event_type: 'Stop' } as unknown as ConformantEvent;

function stubAdapter(overrides: Partial<HookAdapter>): HookAdapter {
  return {
    agentType: 'GEMINI_CLI',
    installConfig: () => ({
      agentName: 'stub',
      hookKinds: [],
      renderSnippet: () => '',
      settingsHint: '',
    }),
    isHookKind: () => true,
    mapPayload: () => {
      throw new Error('mapPayload must not be called when mapBatch handled the invocation');
    },
    transcriptTarget: () => null,
    ...overrides,
  };
}

describe('eventsFor', () => {
  it('respects an EMPTY batch as "handled, emit nothing"', () => {
    const adapter = stubAdapter({ mapBatch: () => [] });
    // The stub's mapPayload throws, so a `||` regression fails loudly here.
    expect(eventsFor(adapter, 'after-model', {})).toEqual([]);
  });

  it('passes a non-empty batch through unchanged', () => {
    const adapter = stubAdapter({ mapBatch: () => [EVENT, EVENT] });
    expect(eventsFor(adapter, 'stop', {})).toHaveLength(2);
  });

  it('falls back to the single-event path when mapBatch returns null', () => {
    const adapter = stubAdapter({ mapBatch: () => null, mapPayload: () => EVENT });
    expect(eventsFor(adapter, 'stop', {})).toEqual([EVENT]);
  });

  it('falls back to the single-event path when the adapter has no mapBatch', () => {
    const adapter = stubAdapter({ mapPayload: () => EVENT });
    expect(eventsFor(adapter, 'stop', {})).toEqual([EVENT]);
  });
});
