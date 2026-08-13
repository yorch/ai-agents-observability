import { describe, expect, it } from 'bun:test';

import { NIL_UUID, sessionUuid } from './session-id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('sessionUuid', () => {
  it('passes an existing UUID through unchanged', () => {
    const id = '01906a44-0000-7000-8000-000000000000';
    expect(sessionUuid('CLAUDE_CODE', id)).toBe(id);
    expect(sessionUuid('PI', id)).toBe(id);
  });

  it('lowercases an uppercase UUID rather than deriving a new one', () => {
    const upper = '01906A44-0000-7000-8000-000000000000';
    expect(sessionUuid('PI', upper)).toBe(upper.toLowerCase());
  });

  it('derives a valid UUID from a non-UUID id', () => {
    // The shape that silently dropped every real opencode session before P12-002.
    expect(sessionUuid('OPENCODE', 'ses_7bQx19aMfTk')).toMatch(UUID_RE);
    // omp session ids are 16-char hex.
    expect(sessionUuid('OMP', '1f9d2a6b9c0d1234')).toMatch(UUID_RE);
  });

  it('is stable for the same (agent, id) so a session stays one session', () => {
    const a = sessionUuid('OPENCODE', 'ses_7bQx19aMfTk');
    const b = sessionUuid('OPENCODE', 'ses_7bQx19aMfTk');
    expect(a).toBe(b);
  });

  it('namespaces by agent so two agents cannot collide on the same native id', () => {
    expect(sessionUuid('OPENCODE', 'ses_abc')).not.toBe(sessionUuid('OMP', 'ses_abc'));
  });

  it('distinguishes different sessions of the same agent', () => {
    expect(sessionUuid('OMP', 'aaaa1111bbbb2222')).not.toBe(sessionUuid('OMP', 'aaaa1111bbbb3333'));
  });

  it('falls back to the nil UUID for a missing or empty id', () => {
    expect(sessionUuid('OPENCODE', undefined)).toBe(NIL_UUID);
    expect(sessionUuid('OPENCODE', '')).toBe(NIL_UUID);
    expect(sessionUuid('OPENCODE', 42)).toBe(NIL_UUID);
    // The nil UUID is itself a valid UUID and must not be re-derived.
    expect(sessionUuid('OPENCODE', NIL_UUID)).toBe(NIL_UUID);
  });
});
