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

  // The three hand-maintained tables, each transcribed from one vendor's own
  // pricing page — so their cache semantics are known and can be asserted tightly.
  const HAND_MAINTAINED = ['claude_code', 'codex', 'gemini_cli'] as const;
  // Generated from the models.dev catalog by `bun run gen:price-tables`, spanning
  // twenty vendors whose cache conventions differ.
  const GENERATED = ['omp', 'opencode', 'pi'] as const;

  it.each(TOKEN_BILLED)('%s prices every model it lists', (agent) => {
    for (const [model, price] of Object.entries(registry.resolve(agent).prices)) {
      // A zero row is indistinguishable from an unpriced model on
      // /admin/price-tables, so it must not be how a real rate is recorded.
      expect(price.input_per_mtok, model).toBeGreaterThan(0);
      expect(price.output_per_mtok, model).toBeGreaterThan(0);
      expect(price.cache_read_per_mtok, model).toBeGreaterThanOrEqual(0);
      expect(price.cache_write_per_mtok, model).toBeGreaterThanOrEqual(0);
      // A cache *hit* is never dearer than reading the same tokens uncached —
      // true at every vendor, and the direction a copy-paste inverts.
      expect(price.cache_read_per_mtok, model).toBeLessThanOrEqual(price.input_per_mtok);
    }
  });

  it.each(HAND_MAINTAINED)('%s charges at least the input rate to write cache', (agent) => {
    // Anthropic charges a 1.25x premium; OpenAI (pre-5.6) and Google charge
    // nothing extra, so the tokens still cost their ordinary input rate. Neither
    // vendor makes a cache write *cheaper* than the input it stores.
    for (const [model, price] of Object.entries(registry.resolve(agent).prices)) {
      expect(price.cache_write_per_mtok, model).toBeGreaterThanOrEqual(price.input_per_mtok);
    }
  });

  it.each(GENERATED)('%s is broad enough to be worth generating', (agent) => {
    // The point of generating these from the agents' own model catalog is
    // coverage: the hand-written versions carried ~30 models across 3 vendors and
    // left everything else billing $0. A regeneration that collapses back to a
    // handful means the catalog shape changed and the generator needs looking at.
    expect(Object.keys(registry.resolve(agent).prices).length).toBeGreaterThan(150);
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

  it('gives the provider-agnostic agents every vendor they can route to', () => {
    // The hand-written versions covered Anthropic, OpenAI and Google only, so a
    // Pi user on Groq or DeepSeek — the whole point of a provider-agnostic agent
    // — billed $0. Spot-check one model per vendor family beyond the big three.
    for (const agent of ['pi', 'omp', 'opencode']) {
      const p = registry.resolve(agent).prices;
      for (const model of [
        'claude-opus-5',
        'gpt-5.4',
        'gemini-3.7-flash',
        'deepseek-chat',
        'kimi-k2-thinking',
        'glm-4.7',
        'grok-4.6',
      ]) {
        expect(p[model], `${agent}:${model}`).toBeDefined();
      }
    }
  });

  it('agrees with the hand-maintained tables on models they share', () => {
    // The generated tables come from models.dev, the hand-maintained ones from
    // each vendor's own pricing page. Where both name the same model they must
    // land on the same number, or one of the two sources has drifted and the
    // same session costs different amounts depending on which agent ran it.
    const generated = registry.resolve('pi').prices;
    for (const agent of ['claude_code', 'codex', 'gemini_cli']) {
      for (const [model, price] of Object.entries(registry.resolve(agent).prices)) {
        const other = generated[model];
        if (!other) {
          continue; // legacy snapshot the catalog has dropped — fine
        }
        expect(other.input_per_mtok, `${agent}:${model} input`).toBe(price.input_per_mtok);
        expect(other.output_per_mtok, `${agent}:${model} output`).toBe(price.output_per_mtok);
      }
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
