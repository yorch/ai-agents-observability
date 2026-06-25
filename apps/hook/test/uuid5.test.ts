import { describe, expect, it } from 'bun:test';

import { deterministicEventId, IMPORT_NAMESPACE, uuidv5 } from '../src/lib/uuid5';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('uuidv5', () => {
  it('produces the same output for the same input (stable)', () => {
    expect(uuidv5('hello')).toBe(uuidv5('hello'));
  });

  it('produces different output for different inputs', () => {
    expect(uuidv5('foo')).not.toBe(uuidv5('bar'));
  });

  it('output matches UUID format', () => {
    expect(uuidv5('test')).toMatch(UUID_RE);
  });

  it('version nibble is 5', () => {
    const result = uuidv5('version-check');
    const parts = result.split('-');
    // Third group starts with '5'
    expect(parts[2]?.charAt(0)).toBe('5');
  });

  it('uses IMPORT_NAMESPACE as default namespace', () => {
    // Calling with explicit namespace == default should match implicit call
    expect(uuidv5('test', IMPORT_NAMESPACE)).toBe(uuidv5('test'));
  });

  it('produces different output for different namespaces', () => {
    const altNamespace = '00000000-0000-0000-0000-000000000000';
    expect(uuidv5('test', altNamespace)).not.toBe(uuidv5('test', IMPORT_NAMESPACE));
  });
});

describe('deterministicEventId', () => {
  it('is stable across calls', () => {
    expect(deterministicEventId('seed')).toBe(deterministicEventId('seed'));
  });

  it('varies with input', () => {
    expect(deterministicEventId('a')).not.toBe(deterministicEventId('b'));
  });

  it('output matches UUID format', () => {
    expect(deterministicEventId('test-seed')).toMatch(UUID_RE);
  });

  it('version nibble is 7 (passes z.uuidv7())', () => {
    const result = deterministicEventId('test-seed');
    // UUID format: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
    // Third group (index 2) starts with '7'
    const parts = result.split('-');
    expect(parts[2]?.charAt(0)).toBe('7');
  });

  it('variant bits are set correctly ([89ab] in first char of 4th group)', () => {
    const result = deterministicEventId('variant-check');
    const parts = result.split('-');
    const variantChar = parts[3]?.charAt(0) ?? '';
    expect(['8', '9', 'a', 'b'].includes(variantChar)).toBe(true);
  });

  it('differs from uuidv5 output for same input (version nibble differs)', () => {
    expect(deterministicEventId('test')).not.toBe(uuidv5('test'));
  });

  it('is stable across many seeds', () => {
    const seeds = ['session-abc', 'tool-use-id:pretool', 'uuid:stop', 'uuid:user'];
    for (const seed of seeds) {
      expect(deterministicEventId(seed)).toBe(deterministicEventId(seed));
    }
  });
});
