import {
  DEFAULT_CHEAP_CATEGORIES,
  type ModelPolicyOverrides,
  parseTierOverrides,
} from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';
import { buildModelPolicy } from './model-policy';

// Three distinct blended rates → one model per band (economy / standard / premium).
const PRICES = {
  cheap: { input_per_mtok: 1, output_per_mtok: 5 },
  dear: { input_per_mtok: 15, output_per_mtok: 75 },
  mid: { input_per_mtok: 3, output_per_mtok: 15 },
};

function overrides(partial: Partial<ModelPolicyOverrides> = {}): ModelPolicyOverrides {
  return {
    allowedModels: [],
    cheapCategories: [],
    tierOverrides: {},
    ...partial,
  };
}

describe('parseTierOverrides', () => {
  it('returns an empty map for a non-object blob', () => {
    expect(parseTierOverrides(null)).toEqual({});
    expect(parseTierOverrides(undefined)).toEqual({});
    expect(parseTierOverrides('premium')).toEqual({});
    expect(parseTierOverrides(42)).toEqual({});
    expect(parseTierOverrides(['premium'])).toEqual({});
  });

  it('keeps entries whose value is a known tier', () => {
    expect(parseTierOverrides({ a: 'economy', b: 'standard', c: 'premium' })).toEqual({
      a: 'economy',
      b: 'standard',
      c: 'premium',
    });
  });

  it('drops entries that are not a known tier, keeping the rest', () => {
    // A hand-edited row must degrade to "no override for that model" rather
    // than poisoning tier resolution.
    expect(parseTierOverrides({ bad: 'PREMIUM', good: 'premium', worse: 3, wrong: null })).toEqual({
      good: 'premium',
    });
  });
});

describe('buildModelPolicy', () => {
  it('derives a tier per model from the price table', () => {
    const policy = buildModelPolicy('CLAUDE_CODE', PRICES);
    expect(policy.tiers).toEqual({ cheap: 'economy', dear: 'premium', mid: 'standard' });
    expect(policy.inputRates).toEqual({ cheap: 1, dear: 15, mid: 3 });
  });

  it('has no tiers and no rates when the price table is unavailable', () => {
    const policy = buildModelPolicy('COPILOT', null);
    expect(policy.tiers).toEqual({});
    expect(policy.inputRates).toEqual({});
    expect(policy.agentType).toBe('COPILOT');
  });

  it('has no tiers when the price table resolved but carries no models', () => {
    const policy = buildModelPolicy('COPILOT', {});
    expect(policy.tiers).toEqual({});
    expect(policy.inputRates).toEqual({});
  });

  it('lets an override replace the derived tier for that model only', () => {
    const policy = buildModelPolicy(
      'CLAUDE_CODE',
      PRICES,
      overrides({ tierOverrides: { dear: 'standard' } }),
    );
    expect(policy.tiers).toEqual({ cheap: 'economy', dear: 'standard', mid: 'standard' });
  });

  it('accepts an override for a model the price table does not carry', () => {
    const policy = buildModelPolicy(
      'CLAUDE_CODE',
      PRICES,
      overrides({ tierOverrides: { unpriced: 'premium' } }),
    );
    expect(policy.tiers.unpriced).toBe('premium');
    // No fabricated rate — savings math must see it as unpriced.
    expect(policy.inputRates.unpriced).toBeUndefined();
  });

  it('defaults to no allow-list, and passes a configured one through', () => {
    expect(buildModelPolicy('CLAUDE_CODE', PRICES).allowedModels).toEqual([]);
    expect(
      buildModelPolicy('CLAUDE_CODE', PRICES, overrides({ allowedModels: ['mid'] })).allowedModels,
    ).toEqual(['mid']);
  });

  it('falls back to the default cheap categories when none are configured', () => {
    expect(buildModelPolicy('CLAUDE_CODE', PRICES).cheapCategories).toEqual([
      ...DEFAULT_CHEAP_CATEGORIES,
    ]);
    // An empty stored list is "unset", not "nothing is cheap".
    expect(buildModelPolicy('CLAUDE_CODE', PRICES, overrides()).cheapCategories).toEqual([
      ...DEFAULT_CHEAP_CATEGORIES,
    ]);
  });

  it('uses the configured cheap categories when there are any', () => {
    const policy = buildModelPolicy(
      'CLAUDE_CODE',
      PRICES,
      overrides({ cheapCategories: ['fs_read'] }),
    );
    expect(policy.cheapCategories).toEqual(['fs_read']);
  });
});
