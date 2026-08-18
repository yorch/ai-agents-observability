import { describe, expect, it } from 'vitest';
import {
  blendedRate,
  deriveModelTiers,
  estimateRoutingSavings,
  isCheapCategory,
  isModelAllowed,
  MAX_SAVINGS_RATIO,
  type ModelPolicySnapshot,
  resolveModelTier,
} from './model-policy';
import type { ModelPrice } from './price-table';

function price(input: number, output: number): ModelPrice {
  return {
    cache_read_per_mtok: input / 10,
    cache_write_per_mtok: input * 1.25,
    input_per_mtok: input,
    output_per_mtok: output,
  };
}

// The real claude_code shape, including the retired Opus 4.1 row at the old
// $15/$75 that skews any mean- or maximum-relative threshold.
const CLAUDE_CODE: Record<string, ModelPrice> = {
  'claude-haiku-4-5': price(1, 5),
  'claude-haiku-4-5-20251001': price(1, 5),
  'claude-opus-4-1-20250805': price(15, 75),
  'claude-opus-5': price(5, 25),
  'claude-sonnet-5': price(2, 10),
};

function snapshot(over: Partial<ModelPolicySnapshot> = {}): ModelPolicySnapshot {
  const tiers = deriveModelTiers(CLAUDE_CODE);
  const inputRates = Object.fromEntries(
    Object.entries(CLAUDE_CODE).map(([m, p]) => [m, p.input_per_mtok]),
  );
  return {
    agentType: 'CLAUDE_CODE',
    allowedModels: [],
    cheapCategories: ['fs_read', 'search'],
    inputRates,
    tiers,
    ...over,
  };
}

describe('blendedRate', () => {
  it('weights input over output without ignoring output', () => {
    // 0.8 * 5 + 0.2 * 25
    expect(blendedRate(price(5, 25))).toBeCloseTo(9, 6);
  });
});

describe('deriveModelTiers', () => {
  it('ranks distinct price levels into three bands', () => {
    const tiers = deriveModelTiers(CLAUDE_CODE);
    // Distinct blended levels: 1.8 (haiku), 3.6 (sonnet), 9 (opus-5), 27 (opus-4-1).
    expect(tiers['claude-haiku-4-5']).toBe('economy');
    expect(tiers['claude-opus-4-1-20250805']).toBe('premium');
  });

  it('gives tied rates the same tier, so dated aliases never diverge', () => {
    const tiers = deriveModelTiers(CLAUDE_CODE);
    expect(tiers['claude-haiku-4-5']).toBe(tiers['claude-haiku-4-5-20251001']);
  });

  it('is invariant to HOW EXTREME a retired rate is, not to its presence', () => {
    // The real invariance claim: ranking by distinct level means an absurdly
    // priced legacy row cannot drag the bands, the way a mean or a
    // multiple-of-cheapest rule would.
    const extreme = { ...CLAUDE_CODE, 'claude-opus-4-1-20250805': price(1000, 5000) };
    const base = deriveModelTiers(CLAUDE_CODE);
    const withExtreme = deriveModelTiers(extreme);
    for (const model of Object.keys(CLAUDE_CODE)) {
      if (model === 'claude-opus-4-1-20250805') {
        continue;
      }
      expect(withExtreme[model]).toBe(base[model]);
    }
  });

  it('DOES shift bands when a distinct level is added or removed', () => {
    // Documented explicitly so nobody "fixes" it by accident: band edges are a
    // function of how many distinct levels exist, so dropping the retired row
    // moves claude-opus-5 from standard into premium. This is why the tier is a
    // default an admin can override, not a verdict.
    const withoutRetired = { ...CLAUDE_CODE };
    delete withoutRetired['claude-opus-4-1-20250805'];
    expect(deriveModelTiers(CLAUDE_CODE)['claude-opus-5']).toBe('standard');
    expect(deriveModelTiers(withoutRetired)['claude-opus-5']).toBe('premium');
  });

  it('is monotone: a dearer model never lands in a cheaper tier', () => {
    const rank = { economy: 0, premium: 2, standard: 1 } as const;
    const tiers = deriveModelTiers(CLAUDE_CODE);
    const models = Object.keys(CLAUDE_CODE);
    for (const a of models) {
      for (const b of models) {
        if (blendedRate(CLAUDE_CODE[a] as ModelPrice) < blendedRate(CLAUDE_CODE[b] as ModelPrice)) {
          expect(rank[tiers[a] as keyof typeof rank]).toBeLessThanOrEqual(
            rank[tiers[b] as keyof typeof rank],
          );
        }
      }
    }
  });

  it('drops unpriced rows rather than ranking them as the cheapest model', () => {
    // A zero rate would otherwise sort first and become every recommendation's
    // target.
    const tiers = deriveModelTiers({
      cheap: price(1, 5),
      dear: price(10, 50),
      free: price(0, 0),
    });
    expect(tiers.free).toBeUndefined();
    expect(Object.keys(tiers).sort()).toEqual(['cheap', 'dear']);
  });

  it('returns an empty map for an empty table rather than throwing', () => {
    // Copilot ships an intentionally empty table — it bills seat allowance.
    expect(deriveModelTiers({})).toEqual({});
  });

  it('calls a single price level standard rather than inventing a spread', () => {
    const tiers = deriveModelTiers({ only: price(3, 15) });
    expect(tiers.only).toBe('standard');
  });

  it('splits two price levels into cheaper and dearer', () => {
    const tiers = deriveModelTiers({ cheap: price(1, 5), dear: price(10, 50) });
    expect(tiers.cheap).toBe('economy');
    expect(tiers.dear).toBe('premium');
  });

  it('scales to a wide spread without collapsing everything into premium', () => {
    // opencode spans ~225x cheapest-to-dearest; a multiple-of-cheapest rule
    // would call almost every model premium.
    const wide: Record<string, ModelPrice> = {};
    for (const [i, input] of [0.05, 0.25, 0.75, 1.25, 2, 3, 5, 10, 15].entries()) {
      wide[`m${i}`] = price(input, input * 6);
    }
    const tiers = deriveModelTiers(wide);
    const counts = { economy: 0, premium: 0, standard: 0 };
    for (const t of Object.values(tiers)) {
      counts[t]++;
    }
    expect(counts.economy).toBeGreaterThan(0);
    expect(counts.standard).toBeGreaterThan(0);
    expect(counts.premium).toBeGreaterThan(0);
    expect(counts.premium).toBeLessThan(Object.keys(wide).length);
  });
});

describe('isModelAllowed', () => {
  it('allows everything when no allow-list is configured', () => {
    expect(isModelAllowed(snapshot(), 'anything-at-all')).toBe(true);
  });

  it('denies a model outside a configured allow-list', () => {
    const p = snapshot({ allowedModels: ['claude-haiku-4-5'] });
    expect(isModelAllowed(p, 'claude-haiku-4-5')).toBe(true);
    expect(isModelAllowed(p, 'claude-opus-5')).toBe(false);
  });
});

describe('isCheapCategory', () => {
  it('matches the configured retrieval categories only', () => {
    expect(isCheapCategory(snapshot(), 'fs_read')).toBe(true);
    expect(isCheapCategory(snapshot(), 'exec')).toBe(false);
  });
});

describe('resolveModelTier', () => {
  it('returns null for a model absent from the table', () => {
    expect(resolveModelTier(snapshot(), 'not-in-table')).toBeNull();
  });
});

describe('estimateRoutingSavings', () => {
  it('returns null for a model with no price entry rather than fabricating one', () => {
    expect(estimateRoutingSavings(snapshot(), 'not-in-table')).toBeNull();
  });

  it('returns null when nothing cheaper exists', () => {
    const out = estimateRoutingSavings(snapshot(), 'claude-haiku-4-5');
    expect(out).toBeNull();
  });

  it('produces a range when the target tier holds models at different rates', () => {
    const p = snapshot({
      inputRates: { dear: 20, t1: 1, t2: 4 },
      tiers: { dear: 'premium', t1: 'economy', t2: 'economy' },
    });
    const out = estimateRoutingSavings(p, 'dear');
    expect(out?.high).toBeCloseTo(1 - 1 / 20, 6);
    expect(out?.low).toBeCloseTo(1 - 4 / 20, 6);
    expect(out?.high).toBeGreaterThan(out?.low as number);
  });

  it('collapses to a point when the target tier holds one rate — not a bug', () => {
    // Both haiku aliases price identically, so low === high. A range is a range
    // even when its width is zero.
    const out = estimateRoutingSavings(snapshot(), 'claude-opus-4-1-20250805');
    expect(out?.low).toBe(out?.high);
    expect(out?.low as number).toBeGreaterThan(0);
  });

  it('derives the ratio from real rates, naming the exact target', () => {
    const out = estimateRoutingSavings(snapshot(), 'claude-opus-4-1-20250805');
    // Opus 4.1 input $15. Retrieval work targets the ECONOMY tier, which holds
    // the two haiku aliases at $1 — so the range collapses to a point here.
    expect(out?.targetTier).toBe('economy');
    expect(out?.bestTargetModel).toMatch(/^claude-haiku-4-5/);
    expect(out?.high).toBeCloseTo(1 - 1 / 15, 6);
    expect(out?.low).toBeCloseTo(1 - 1 / 15, 6);
  });

  it('targets the cheapest tier, since the work being rerouted is retrieval', () => {
    const p = snapshot({
      inputRates: { cheap: 1, dear: 20, mid: 10 },
      tiers: { cheap: 'economy', dear: 'premium', mid: 'standard' },
    });
    const out = estimateRoutingSavings(p, 'dear');
    expect(out?.targetTier).toBe('economy');
    expect(out?.bestTargetModel).toBe('cheap');
    // Stepping down one tier would have offered "route $20 work to a $10 model"
    // as the conservative bound; going to economy gives 95% instead.
    expect(out?.high).toBeCloseTo(1 - 1 / 20, 6);
  });

  it('never claims more than the cap', () => {
    const p = snapshot({
      inputRates: { free: 0.0001, huge: 1000 },
      tiers: { free: 'economy', huge: 'premium' },
    });
    const out = estimateRoutingSavings(p, 'huge');
    // Un-clamped this would be 0.9999999; the cap is the only thing producing
    // 0.95, so assert the exact value rather than an upper bound.
    expect(out?.high).toBe(MAX_SAVINGS_RATIO);
    expect(out?.low).toBe(MAX_SAVINGS_RATIO);
  });

  it('returns null when a cheaper tier names only models it cannot price', () => {
    // Reachable via an admin override that classifies a model absent from the
    // price table.
    const p = snapshot({
      inputRates: { dear: 10 },
      tiers: { dear: 'premium', ghost: 'economy' },
    });
    expect(estimateRoutingSavings(p, 'dear')).toBeNull();
  });

  it('returns null when every cheaper-tier model is actually dearer', () => {
    const p = snapshot({
      inputRates: { mislabelled: 20, target: 10 },
      tiers: { mislabelled: 'economy', target: 'premium' },
    });
    expect(estimateRoutingSavings(p, 'target')).toBeNull();
  });

  it('never applies one agent price ratio to another agent models', () => {
    // A snapshot only ever carries one agent's rates, so a model absent from
    // this agent's table resolves to null even if another agent prices it.
    const gemini: ModelPolicySnapshot = {
      agentType: 'GEMINI_CLI',
      allowedModels: [],
      cheapCategories: ['fs_read'],
      inputRates: { 'gemini-2.5-flash': 0.3, 'gemini-2.5-pro': 1.25 },
      tiers: { 'gemini-2.5-flash': 'economy', 'gemini-2.5-pro': 'premium' },
    };
    expect(estimateRoutingSavings(gemini, 'claude-opus-5')).toBeNull();
  });
});
