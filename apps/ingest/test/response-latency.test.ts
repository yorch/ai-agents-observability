import { describe, expect, it } from 'vitest';

import { aggregateResponseLatency, MAX_RESPONSE_GAP_MS } from '../src/lib/response-latency';

describe('aggregateResponseLatency', () => {
  it('sums and counts gaps for blocking notifications per session', () => {
    const out = aggregateResponseLatency([
      { gap_ms: 1000, notification_kind: 'permission', session_id: 's1' },
      { gap_ms: 3000, notification_kind: 'idle', session_id: 's1' },
      { gap_ms: 500, notification_kind: 'elicitation', session_id: 's2' },
    ]);
    expect(out.get('s1')).toEqual({ sampleCount: 2, totalMs: 4000 });
    expect(out.get('s2')).toEqual({ sampleCount: 1, totalMs: 500 });
  });

  it('ignores non-blocking and unknown notification kinds', () => {
    const out = aggregateResponseLatency([
      { gap_ms: 1000, notification_kind: 'auth', session_id: 's1' },
      { gap_ms: 1000, notification_kind: 'other', session_id: 's1' },
      { gap_ms: 1000, notification_kind: null, session_id: 's1' },
    ]);
    expect(out.has('s1')).toBe(false);
  });

  it('caps oversized gaps and drops negative/non-finite ones', () => {
    const out = aggregateResponseLatency([
      { gap_ms: MAX_RESPONSE_GAP_MS * 5, notification_kind: 'permission', session_id: 's1' },
      { gap_ms: -10, notification_kind: 'permission', session_id: 's1' },
      { gap_ms: Number.NaN, notification_kind: 'permission', session_id: 's1' },
    ]);
    expect(out.get('s1')).toEqual({ sampleCount: 1, totalMs: MAX_RESPONSE_GAP_MS });
  });
});
