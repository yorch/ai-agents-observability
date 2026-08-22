// The model-routing policy: what counts as expensive, what work is cheap enough
// to downgrade, and which models an org allows. Shared between apps/web (the
// /org/models recommendations and the /admin/model-policy editor) and
// apps/ingest (the routing_waste and disallowed_model alert evaluators).
// apps/ingest cannot import from apps/web, so — exactly like ./alerts — the one
// definition lives here and both sides read it.
//
// Before this module, "premium" was the literal substring `opus` in two places:
// a constant in apps/web and a raw-SQL `ILIKE '%opus%'` in apps/ingest. That is
// wrong twice over: it silently never matches the six non-Anthropic agents, and
// two copies of a policy drift.

import type { ModelPrice } from './price-table';

export const MODEL_TIERS = ['economy', 'standard', 'premium'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

// Tool categories cheap enough that a downgraded model is a safe target: pure
// retrieval, no hard reasoning. `exec` is deliberately excluded — a tool call
// can gate on reasoning about its result.
export const DEFAULT_CHEAP_CATEGORIES = ['fs_read', 'search'] as const;

// Tiering ranks models by a blend of input and output rates. Coding traffic is
// input-dominated, but output tokens cost several times more per token, so
// neither rate alone ranks models the way spend actually lands.
export const TIER_INPUT_WEIGHT = 0.8;
export const TIER_OUTPUT_WEIGHT = 0.2;

// Never claim more than this even when the raw price ratio implies it: a
// retrieval turn still carries irreducible cost on the target model.
export const MAX_SAVINGS_RATIO = 0.95;

// A downgrade has to be worth the behaviour change. Below this best-case saving
// we do not raise a recommendation at all.
export const MIN_SAVINGS_RATIO = 0.25;

/** The subset of a price row that ranking actually reads. */
export type RankableRate = Pick<ModelPrice, 'input_per_mtok' | 'output_per_mtok'>;

/** Rate used to rank a model against its peers. Not a billing figure. */
export function blendedRate(price: RankableRate): number {
  return TIER_INPUT_WEIGHT * price.input_per_mtok + TIER_OUTPUT_WEIGHT * price.output_per_mtok;
}

/**
 * Assign a tier to every model in ONE agent's price table.
 *
 * Ranks the **distinct** blended rates and splits them into three bands, rather
 * than thresholding on an absolute rate or a multiple of the cheapest model.
 * Both of those alternatives fail on real data: the spread between the cheapest
 * and dearest model is ~19x for `claude_code` but ~8000x for `opencode` (whose
 * table is generated from the models.dev catalog and spans 20 vendors), so one
 * multiple cannot serve both; and price tables retain retired models (Opus 4.1
 * at the old $15/$75, three times today's Opus) which drag any mean or maximum.
 * Ranking distinct levels is invariant to both.
 *
 * Ties share a tier by construction — same rate, same band — so the dated and
 * undated aliases of one model (`claude-haiku-4-5` / `claude-haiku-4-5-20251001`)
 * can never land differently.
 *
 * This is a *default*, not a verdict: an org admin overrides any model through
 * the model policy (P10-002). Derivation exists so a newly-added agent gets
 * sensible tiers with no manual entry, not to be the last word.
 */
export function deriveModelTiers(prices: Record<string, RankableRate>): Record<string, ModelTier> {
  const entries = Object.entries(prices).filter(([, p]) => blendedRate(p) > 0);
  if (entries.length === 0) {
    return {};
  }

  // Each rate is computed ONCE and carried, rather than recomputed and looked
  // up by value. Recomputation happens to be bit-stable for the same input, so
  // a lookup would work today — but it would make correctness depend on float
  // reproducibility, and any later change to how the rate is derived (a cache,
  // a rounding step) would silently return rank -1 and tier everything economy.
  const rated = entries.map(([model, price]) => ({ model, rate: blendedRate(price) }));
  const levels = [...new Set(rated.map((r) => r.rate))].sort((a, b) => a - b);
  const rankOf = new Map(levels.map((rate, i) => [rate, i]));

  // With one distinct rate there is no ranking to do, and with two the split is
  // cheaper/dearer — calling either of those a three-tier spread would invent a
  // structure the data does not have.
  const bandFor = (rank: number): ModelTier => {
    if (levels.length === 1) {
      return 'standard';
    }
    if (levels.length === 2) {
      return rank === 0 ? 'economy' : 'premium';
    }
    // band <= levels.length / 3, so the economy and premium bands can never
    // overlap: `rank < band` and `rank >= length - band` are disjoint whenever
    // 2 * band <= length, which floor division guarantees.
    const band = Math.floor(levels.length / 3);
    if (rank < band) {
      return 'economy';
    }
    return rank >= levels.length - band ? 'premium' : 'standard';
  };

  const out: Record<string, ModelTier> = {};
  for (const { model, rate } of rated) {
    out[model] = bandFor(rankOf.get(rate) as number);
  }
  return out;
}

/**
 * One agent's resolved policy — derived defaults with the org's overrides
 * already applied. Both apps resolve against this shape so neither re-implements
 * the merge.
 */
export type ModelPolicySnapshot = {
  agentType: string;
  /** Empty means "no allow-list configured" — every model is allowed. */
  allowedModels: string[];
  cheapCategories: string[];
  /** Input rate per Mtok, for savings math. Missing model = unpriced. */
  inputRates: Record<string, number>;
  tiers: Record<string, ModelTier>;
};

/** Narrow a stored `tier_overrides` JSON blob, dropping anything unrecognised. */
export function parseTierOverrides(raw: unknown): Record<string, ModelTier> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, ModelTier> = {};
  for (const [model, tier] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof tier === 'string' && (MODEL_TIERS as readonly string[]).includes(tier)) {
      out[model] = tier as ModelTier;
    }
  }
  return out;
}

/** The org's stored overrides for one agent, straight off the `model_policy` row. */
export type ModelPolicyOverrides = {
  allowedModels: string[];
  cheapCategories: string[];
  tierOverrides: unknown;
};

/**
 * Assemble one agent's resolved policy from its prices plus the org's overrides.
 *
 * Both apps call this. Only *obtaining* the prices differs between them — over
 * HTTP in apps/web, from the in-process tables in apps/ingest — so that is the
 * only part either app implements itself. Overrides win over derivation and may
 * name a model the price table lacks: an admin can classify a model before it is
 * priced, they just get no savings estimate until it is.
 */
export function resolveModelPolicySnapshot(
  agentType: string,
  prices: Record<string, RankableRate>,
  overrides?: ModelPolicyOverrides,
): ModelPolicySnapshot {
  return {
    agentType,
    allowedModels: overrides?.allowedModels ?? [],
    cheapCategories: overrides?.cheapCategories?.length
      ? overrides.cheapCategories
      : [...DEFAULT_CHEAP_CATEGORIES],
    inputRates: Object.fromEntries(Object.entries(prices).map(([m, p]) => [m, p.input_per_mtok])),
    tiers: { ...deriveModelTiers(prices), ...parseTierOverrides(overrides?.tierOverrides) },
  };
}

export function resolveModelTier(policy: ModelPolicySnapshot, model: string): ModelTier | null {
  return policy.tiers[model] ?? null;
}

/**
 * An empty allow-list means unconfigured, never "deny everything" — a policy
 * nobody has filled in must not turn every session into a governance alert.
 *
 * NOTE: the `disallowed_model` evaluator cannot call this — it applies the rule
 * inside a SQL aggregate over the events hypertable, where pulling every row
 * into JS to test them one at a time is not an option. That query therefore
 * carries a **deliberate second encoding** of this rule
 * (`COALESCE(array_length(allowed_models, 1), 0) > 0 AND NOT (model = ANY(...))`).
 * This function is the readable statement of the contract and what the unit
 * tests pin; if you change the semantics here, change that query too.
 */
export function isModelAllowed(policy: ModelPolicySnapshot, model: string): boolean {
  return policy.allowedModels.length === 0 || policy.allowedModels.includes(model);
}

export function isCheapCategory(policy: ModelPolicySnapshot, toolCategory: string): boolean {
  return policy.cheapCategories.includes(toolCategory);
}

/**
 * Cheapest-first rank of a tier. Derived from MODEL_TIERS rather than a second
 * hand-maintained map, so adding or reordering a tier cannot leave the two out
 * of step.
 */
function tierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

/** A downgrade savings estimate as a range, never a point estimate. */
export type SavingsRange = {
  /** Cheapest model in the target tier — the best case. */
  bestTargetModel: string;
  high: number;
  low: number;
  targetTier: ModelTier;
};

/**
 * Estimate what routing `model`'s retrieval work to a cheaper tier would save,
 * as a fraction of that spend, expressed as a **range**.
 *
 * The range is real, not decoration: the target tier holds several models at
 * different rates, so the saving depends on which one the team picks. `high`
 * uses the cheapest model in the target tier, `low` the dearest. Reporting the
 * midpoint as a single number is the "precisely misleading" figure DESIGN_DOC
 * §10.6 warns against.
 *
 * Returns `null` — never a fabricated number — when the model has no price
 * entry, or when no cheaper tier has any priced model. Ratios come from the
 * **input** rate because retrieval turns are input-dominated.
 *
 * Every input comes from one agent's policy, so one agent's price ratio can
 * never be applied to another agent's models.
 */
export function estimateRoutingSavings(
  policy: ModelPolicySnapshot,
  model: string,
): SavingsRange | null {
  const rate = policy.inputRates[model];
  const tier = resolveModelTier(policy, model);
  if (!rate || rate <= 0 || tier === null) {
    return null;
  }

  // Target the CHEAPEST tier that has a strictly cheaper priced model — not the
  // adjacent one. The work being rerouted is pure retrieval, so the cheapest
  // tier is exactly what suits it; stepping down one tier at a time produces
  // absurd advice on real tables. Concretely, `claude_code` tiers retired Opus
  // 4.1 ($15) premium and current Opus 5 ($5) standard, so an adjacent-tier rule
  // makes the conservative end of the range "route Opus 4.1's file reads to
  // Opus 5" — not a downgrade anyone would act on. Going to economy gives a
  // tight, honest range over models that genuinely handle reads.
  //
  // MODEL_TIERS is ordered cheapest-first, so the first tier with candidates
  // wins.
  let targetTier: ModelTier | null = null;
  let candidates: { model: string; rate: number }[] = [];
  for (const candidateTier of MODEL_TIERS) {
    if (tierRank(candidateTier) >= tierRank(tier)) {
      continue;
    }
    const inTier = Object.entries(policy.tiers)
      .filter(([m, t]) => t === candidateTier && (policy.inputRates[m] ?? 0) > 0)
      .map(([m]) => ({ model: m, rate: policy.inputRates[m] as number }))
      .filter((c) => c.rate < rate);
    if (inTier.length > 0) {
      targetTier = candidateTier;
      candidates = inTier;
      break;
    }
  }

  if (targetTier === null || candidates.length === 0) {
    return null;
  }

  const cheapest = candidates.reduce((a, b) => (b.rate < a.rate ? b : a));
  const dearest = candidates.reduce((a, b) => (b.rate > a.rate ? b : a));
  const clamp = (n: number) => Math.max(0, Math.min(MAX_SAVINGS_RATIO, n));

  return {
    bestTargetModel: cheapest.model,
    high: clamp(1 - cheapest.rate / rate),
    low: clamp(1 - dearest.rate / rate),
    targetTier,
  };
}
