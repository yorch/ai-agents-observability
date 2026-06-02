import { describe, expect, it } from 'vitest';
import { normalizeHost } from '../src/config';

describe('normalizeHost', () => {
  it('prepends https:// to a bare host (shared .env compatibility)', () => {
    expect(normalizeHost('github.com')).toBe('https://github.com');
    expect(normalizeHost('ghe.acme.internal')).toBe('https://ghe.acme.internal');
  });

  it('leaves a full URL untouched', () => {
    expect(normalizeHost('https://github.com')).toBe('https://github.com');
    expect(normalizeHost('http://ghe.local')).toBe('http://ghe.local');
  });

  it('passes through undefined', () => {
    expect(normalizeHost(undefined)).toBeUndefined();
  });
});
