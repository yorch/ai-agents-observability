import { describe, expect, it } from 'bun:test';
import { EventsBatchSchema } from '@ai-agents-observability/schemas';

import { buildBatchEnvelope } from '../src/flusher';

// A queued event payload as produced by the hook (see lib/payload.ts → toEvent).
// Each event carries its own session_context; the batch envelope reuses it.
function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_type: 'CLAUDE_CODE',
    client: { claude_code_version: '1.0.0', hostname_hash: 'abc123', os: 'linux' },
    event_id: '01906a44-0000-7000-8000-000000000001',
    event_type: 'Stop',
    metadata: {},
    redaction_flags: [],
    schema_version: 1,
    session_context: { cwd: '/home/user/project', git: null, is_resume: false, mode: 'normal' },
    session_id: '01906a44-0000-7000-8000-000000000000',
    ts: '2025-05-17T00:00:00Z',
    user_id_claim: 'github:alice',
    ...overrides,
  };
}

describe('buildBatchEnvelope', () => {
  it('produces a body that passes the ingest EventsBatchSchema', () => {
    const events = [makeEvent(), makeEvent({ event_id: '01906a44-0000-7000-8000-000000000002' })];
    const body = buildBatchEnvelope(events);
    const result = EventsBatchSchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('uses the newest event session_context as the envelope', () => {
    const older = makeEvent({
      event_id: '01906a44-0000-7000-8000-000000000001',
      session_context: { cwd: '/old', git: null, is_resume: false, mode: 'normal' },
    });
    const newer = makeEvent({
      event_id: '01906a44-0000-7000-8000-000000000002',
      session_context: { cwd: '/new', git: null, is_resume: false, mode: 'plan' },
    });
    const body = buildBatchEnvelope([older, newer]);
    expect((body.session_context as { cwd: string }).cwd).toBe('/new');
  });

  it('never emits a null top-level session_context for a non-empty batch', () => {
    const body = buildBatchEnvelope([makeEvent()]);
    expect(body.session_context).not.toBeNull();
  });
});
