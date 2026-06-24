import { describe, expect, it } from 'vitest';

import { buildPriceTableRegistry } from '../src/lib/price-tables';

describe('price-table registry', () => {
  const registry = buildPriceTableRegistry();

  it('resolves the claude_code table (hyphen or underscore agent_type)', () => {
    const a = registry.resolve('claude_code');
    const b = registry.resolve('claude-code');
    expect(a).toBe(b);
    expect(Object.keys(a.prices).length).toBeGreaterThan(0);
  });

  it('resolves the opencode table with real (populated) prices', () => {
    const t = registry.resolve('opencode');
    expect(t.version).toBe('opencode.v1');
    expect(Object.keys(t.prices).length).toBeGreaterThan(0);
    // At least one real, non-zero model price (P8-004 acceptance).
    expect(t.prices['claude-sonnet-4-5-20250929']?.input_per_mtok).toBeGreaterThan(0);
  });

  it('registers a codex table (P8-007 placeholder: known agent, intentionally empty prices)', () => {
    // Codex is a KNOWN agent (so forAgentParam serves it, not null) but ships an
    // empty price table until real OpenAI rates are filled in — every model bills
    // $0 via the empty table rather than the unknown-agent fallback.
    const t = registry.resolve('codex');
    expect(t.version).toBe('codex.v1');
    expect(Object.keys(t.prices)).toHaveLength(0);
    expect(registry.forAgentParam('codex')).toBe(t);
  });

  it('returns an empty table for an unknown agent (so models bill $0)', () => {
    const t = registry.resolve('totally-unknown-agent');
    expect(Object.keys(t.prices)).toHaveLength(0);
  });

  it('forAgentParam defaults to claude_code and 404s (null) for unknown agents', () => {
    expect(registry.forAgentParam(undefined)).toBe(registry.resolve('claude_code'));
    expect(registry.forAgentParam('opencode')).toBe(registry.resolve('opencode'));
    expect(registry.forAgentParam('nope')).toBeNull();
  });
});
