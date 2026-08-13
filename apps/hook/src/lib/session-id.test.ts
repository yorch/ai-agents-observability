import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { NIL_UUID, sessionUuid } from './session-id';

// The oracle is zod's `z.uuid()` — the exact check `EventSchema` applies at
// ingest — NOT a local regex. A regex copied from the implementation would
// validate the code against its own bugs, which is how a too-loose UUID test
// could pass while ingest silently dropped the events.
const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

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
    expect(isUuid(sessionUuid('OPENCODE', 'ses_7bQx19aMfTk'))).toBe(true);
    // omp session ids are 16-char hex.
    expect(isUuid(sessionUuid('OMP', '1f9d2a6b9c0d1234'))).toBe(true);
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

  it('falls back to the nil UUID only for a genuinely absent id', () => {
    expect(sessionUuid('OPENCODE', undefined)).toBe(NIL_UUID);
    expect(sessionUuid('OPENCODE', '')).toBe(NIL_UUID);
    expect(sessionUuid('OPENCODE', {})).toBe(NIL_UUID);
    // The nil UUID is itself a valid UUID and must not be re-derived.
    expect(sessionUuid('OPENCODE', NIL_UUID)).toBe(NIL_UUID);
  });

  it('derives from a UUID-SHAPED string that is not a valid RFC UUID', () => {
    // Dashed hex with an out-of-range version/variant nibble: zod rejects it, so
    // passing it through would hand ingest an id it drops on the floor.
    const shaped = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(isUuid(shaped)).toBe(false);
    const derived = sessionUuid('CODEX', shaped);
    expect(derived).not.toBe(shaped);
    expect(isUuid(derived)).toBe(true);
  });

  it('derives from a numeric id rather than collapsing every session into one', () => {
    const first = sessionUuid('OPENCODE', 42);
    expect(first).not.toBe(NIL_UUID);
    expect(first).toBe(sessionUuid('OPENCODE', '42'));
    expect(first).not.toBe(sessionUuid('OPENCODE', 43));
  });
});
