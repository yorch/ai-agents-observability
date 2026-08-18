import { describe, expect, it } from 'vitest';

import rawCopilot from '../src/data/price-table.copilot.v1.json' with { type: 'json' };
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

  it('registers a codex table with real OpenAI prices (P8-007)', () => {
    const t = registry.resolve('codex');
    expect(t.version).toBe('codex.v1');
    expect(Object.keys(t.prices).length).toBeGreaterThan(0);
    // Spot-check a known model price (gpt-4o).
    expect(t.prices['gpt-4o']?.input_per_mtok).toBeGreaterThan(0);
    expect(registry.forAgentParam('codex')).toBe(t);
  });

  // Every agent that ships an adapter and bills per token needs priced models,
  // or its sessions silently read $0. Copilot is the deliberate exception: it
  // bills premium requests, not tokens, so a per-mtok row would be invented.
  const TOKEN_BILLED = ['claude_code', 'codex', 'gemini_cli', 'omp', 'opencode', 'pi'] as const;

  it.each(TOKEN_BILLED)('%s prices at least one model', (agent) => {
    expect(Object.keys(registry.resolve(agent).prices).length).toBeGreaterThan(0);
  });

  it('leaves the copilot table empty on purpose, and says why', () => {
    const t = registry.resolve('copilot');
    expect(Object.keys(t.prices)).toHaveLength(0);
    // The comment is the only place the reasoning lives; losing it turns a
    // decision back into an oversight. Read the file, not the parsed table —
    // PriceTableSchema strips `_comment`.
    expect(rawCopilot._comment).toMatch(/premium request/i);
  });

  it.each(TOKEN_BILLED)('%s prices are internally consistent', (agent) => {
    for (const [model, price] of Object.entries(registry.resolve(agent).prices)) {
      expect(price.input_per_mtok, model).toBeGreaterThan(0);
      expect(price.output_per_mtok, model).toBeGreaterThan(0);
      // A cache hit is a discount on input at every provider we list, and a
      // cache write is never cheaper than the input it stores. Both have been
      // inverted by a copy-paste before.
      expect(price.cache_read_per_mtok, model).toBeLessThan(price.input_per_mtok);
      expect(price.cache_write_per_mtok, model).toBeGreaterThanOrEqual(price.input_per_mtok);
    }
  });

  // Guards the 2026-08-18 refresh: these were wrong in the shipped tables
  // (Opus priced at the retired 4.1 rate, Haiku at the retired 3.5 rate), so
  // every session on a current model reported the wrong cost.
  it('prices current Anthropic models at their published rates', () => {
    const p = registry.resolve('claude_code').prices;
    expect(p['claude-opus-5']).toMatchObject({ input_per_mtok: 5, output_per_mtok: 25 });
    expect(p['claude-opus-4-6']).toMatchObject({ input_per_mtok: 5, output_per_mtok: 25 });
    expect(p['claude-sonnet-5']).toMatchObject({ input_per_mtok: 2, output_per_mtok: 10 });
    expect(p['claude-haiku-4-5']).toMatchObject({ input_per_mtok: 1, output_per_mtok: 5 });
    // 5m write is 1.25x input, a cache hit 0.1x — the multipliers, not literals.
    for (const price of Object.values(p)) {
      expect(price.cache_write_per_mtok).toBeCloseTo(price.input_per_mtok * 1.25, 6);
      expect(price.cache_read_per_mtok).toBeCloseTo(price.input_per_mtok * 0.1, 6);
    }
  });

  it('prices the model Codex actually runs today', () => {
    // The shipped table stopped at the gpt-4o/o1 era, so every current Codex
    // turn fell through to $0.
    const p = registry.resolve('codex').prices;
    expect(p['gpt-5.4']).toMatchObject({ input_per_mtok: 2.5, output_per_mtok: 15 });
    expect(p['gpt-5.3-codex']).toMatchObject({ input_per_mtok: 1.75, output_per_mtok: 14 });
  });

  it('prices Gemini CLI models', () => {
    const p = registry.resolve('gemini_cli').prices;
    expect(p['gemini-3.7-flash']).toMatchObject({ input_per_mtok: 0.75, output_per_mtok: 3.75 });
    expect(p['gemini-2.5-pro']).toMatchObject({ input_per_mtok: 1.25, output_per_mtok: 10 });
  });

  it('gives the provider-agnostic agents all three providers', () => {
    for (const agent of ['pi', 'omp', 'opencode']) {
      const p = registry.resolve(agent).prices;
      expect(p['claude-opus-5'], agent).toBeDefined();
      expect(p['gpt-5.4'], agent).toBeDefined();
      expect(p['gemini-3.7-flash'], agent).toBeDefined();
    }
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
