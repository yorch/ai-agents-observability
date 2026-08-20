import type { Prisma } from '@ai-agents-observability/db';
import { SCORER_NAMES, SCORERS } from '@ai-agents-observability/schemas';

import { getPrisma } from './prisma';

/**
 * The projection registry (P13-006). Supersedes P10-006.
 *
 * The product makes predictive claims in several places — "route retrieval work
 * to a cheaper tier and save $X", "you are on pace for $Y this month" — and until
 * now none of them ever checked itself. A recommendation surface that never
 * checks itself drifts into vanity metrics (`DESIGN_DOC.md` §10.5); worse, a
 * claim made before a store exists can *never* be checked, because there is no
 * record of what was claimed. That is why the registry ships ahead of the
 * analysis that consumes it, and why nothing here is retroactive.
 *
 * Three rules are enforced by the shape of this module rather than by review:
 *
 * 1. **Rendering is recording.** A claim's numbers are only reachable through a
 *    `RegisteredProjection`, and the only way to *obtain* one is
 *    `recordProjection`/`recordProjections`, which persist. A component that
 *    displays a claim asks for that type, so passing an unrecorded projection is
 *    a compile error. See the brand's own note for the precise strength of this:
 *    it stops the accident, not a determined bypass.
 * 2. **Ranges, never point estimates.** `projectedLow`/`projectedHigh` are two
 *    required numbers. There is no single-value constructor to reach for.
 * 3. **Silence beats a spurious number.** Below a claim's post-period volume
 *    floor, realization returns `not_yet_measurable` — never a delta computed
 *    from three sessions.
 */

/** Rates and scores live in [0, 1]; spend is USD. */
export type ProjectionUnit = 'usd';

/**
 * How a claim's realized quantity relates to its baseline.
 *
 * - `level`: the projection is the value itself ("month-end spend will be $X").
 * - `reduction`: the projection is the *drop* from the baseline ("you would save
 *   $X"), so the realized quantity is `baseline − actual`.
 */
export type RealizedQuantity = 'level' | 'reduction';

export type ProjectionClaimDefinition = {
  /** Which direction of miss is good news for the reader of this claim. */
  readonly betterWhen: 'above' | 'below';
  readonly description: string;
  /**
   * Post-period volume below which no comparison is reported. Not a statistical
   * threshold — a floor beneath which a delta is obviously noise, chosen per
   * claim because a month of org spend and one model's retrieval turns are not
   * the same kind of count.
   */
  readonly minPostPeriodVolume: number;
  readonly realizedQuantity: RealizedQuantity;
  readonly unit: ProjectionUnit;
  /** What `minPostPeriodVolume` counts, for the "not yet measurable" copy. */
  readonly volumeNoun: string;
};

/**
 * The claim registry. Adding a predictive surface means adding an entry here —
 * `claimType` is `keyof typeof PROJECTION_CLAIMS`, so a claim type that is not
 * registered is a compile error rather than a string that quietly writes rows
 * nobody will ever look for.
 */
export const PROJECTION_CLAIMS = {
  budget_window_spend: {
    betterWhen: 'below',
    description: 'Projected spend over the configured budget window at the trailing run rate.',
    minPostPeriodVolume: 20,
    realizedQuantity: 'level',
    unit: 'usd',
    volumeNoun: 'sessions',
  },
  monthly_spend: {
    betterWhen: 'below',
    description: 'Projected total org spend for the calendar month, from month-to-date pace.',
    minPostPeriodVolume: 20,
    realizedQuantity: 'level',
    unit: 'usd',
    volumeNoun: 'sessions',
  },
  rolling_30d_spend: {
    betterWhen: 'below',
    description: 'Projected spend over the next 30 days at the trailing run rate.',
    minPostPeriodVolume: 20,
    realizedQuantity: 'level',
    unit: 'usd',
    volumeNoun: 'sessions',
  },
  routing_savings: {
    betterWhen: 'above',
    description:
      'Spend that would be avoided by routing a premium model’s retrieval-only turns to a cheaper tier.',
    minPostPeriodVolume: 50,
    realizedQuantity: 'reduction',
    unit: 'usd',
    volumeNoun: 'tool calls',
  },
} as const satisfies Record<string, ProjectionClaimDefinition>;

export type ProjectionClaimType = keyof typeof PROJECTION_CLAIMS;

export const PROJECTION_CLAIM_TYPES = Object.keys(PROJECTION_CLAIMS) as ProjectionClaimType[];

/**
 * The outcome guard's inputs: the three ways a "saving" can be a degradation
 * wearing a win's clothing. All in [0, 1]; null means "not measurable for this
 * segment", which is reported as such rather than treated as zero.
 */
export type GuardMetrics = {
  frictionMean: number | null;
  revertRate: number | null;
  toolErrorRate: number | null;
};

export const EMPTY_GUARD: GuardMetrics = {
  frictionMean: null,
  revertRate: null,
  toolErrorRate: null,
};

/**
 * A rise of more than this (absolute, on a [0, 1] rate) between the projection's
 * baseline and the post-period actual counts as a degradation. Deliberately
 * coarse: the guard exists to stop a win being celebrated over a visibly worse
 * outcome, not to detect small movements, and a tight threshold would flag noise
 * until nobody reads the flag.
 */
export const GUARD_RISE_THRESHOLD = 0.05;

export type ProjectionInput = {
  baselineValue: number;
  baselineWindowDays: number;
  claimType: ProjectionClaimType;
  /** Guard metrics for this segment *as of the claim*, not after it. */
  guardBaseline: GuardMetrics;
  metadata?: Record<string, unknown>;
  periodEnd: Date;
  periodStart: Date;
  /** Price table version active at claim time, when the claim depends on prices. */
  priceTableVersion?: string | null;
  projectedHigh: number;
  projectedLow: number;
  segment: string;
};

/** A projection as read back from the store. */
export type StoredProjection = ProjectionInput & {
  createdAt: Date;
  id: string;
  scorerVersions: Record<string, number>;
  unit: ProjectionUnit;
};

/**
 * The brand behind "the function that renders is the function that records": a
 * claim component's props ask for this type, and only `recordProjection(s)`
 * returns one.
 *
 * **What this actually guarantees, precisely.** A `StoredProjection` — or any
 * object literal — is *not* assignable to `RegisteredProjection`, so a call site
 * cannot pass an unrecorded claim to a claim component by accident, and cannot
 * construct one by writing out the fields. That is the failure this is here to
 * prevent, and the compile-time assertion below pins it. (That assertion lives in
 * this file rather than in `test/` because `apps/web`'s tsconfig typechecks only
 * `src/**`, so a `.test-d.ts` under `test/` would never actually run.)
 *
 * **What it does not guarantee.** `RegisteredProjection` is structurally a
 * subtype of `StoredProjection`, so TypeScript permits a single narrowing
 * assertion — `stored as RegisteredProjection` compiles, with no
 * `as unknown as` needed. An earlier version of this comment claimed otherwise;
 * it was wrong. The brand is a guard rail against the accident, and a visible
 * `as RegisteredProjection` in a diff is the review signal. It is not a
 * capability boundary, and nothing here should be read as one.
 */
declare const registeredBrand: unique symbol;

export type RegisteredProjection = StoredProjection & { readonly [registeredBrand]: true };

/**
 * Compile-time pin for the guarantee above: an unbranded `StoredProjection` must
 * NOT be assignable to `RegisteredProjection`. If the brand is ever removed, this
 * fails `bun run typecheck` instead of quietly widening what a claim component
 * accepts.
 */
type AssertTrue<T extends true> = T;
export type StoredIsNotRegistered = AssertTrue<
  StoredProjection extends RegisteredProjection ? false : true
>;

/** What actually happened during the projection's target period. */
export type PostPeriodActuals = {
  /** The measured quantity in the claim's unit (a level, not a delta). */
  actualValue: number;
  guard: GuardMetrics;
  /** Rows behind `actualValue`, checked against the claim's volume floor. */
  volume: number;
};

export type RealizationStatus =
  | 'above_range'
  | 'below_range'
  | 'not_yet_measurable'
  | 'period_open'
  | 'within_range';

export type GuardBreach = {
  after: number;
  before: number;
  metric: keyof GuardMetrics;
};

export type Realization = {
  /** The measured level, or null when nothing is measurable yet. */
  actualValue: number | null;
  /** Which guard metrics rose past the threshold over the period. */
  guardBreaches: GuardBreach[];
  /** Guard metrics that could not be measured — reported, never assumed benign. */
  guardUnavailable: (keyof GuardMetrics)[];
  /**
   * True when the realization must not be presented as a win: outcomes for this
   * segment got measurably worse over the same period. Set independently of
   * whether the number came in — a "saving" beside a rising revert rate is the
   * exact case P10-006 was written to catch.
   */
  outcomeFlagged: boolean;
  projection: StoredProjection;
  /** Plain-language account of the status, for display and for tests to assert. */
  reason: string;
  /** The realized quantity compared against the range (level or reduction). */
  realizedValue: number | null;
  status: RealizationStatus;
  /** Whether the claim came true in the direction that favours the reader. */
  wentBetterThanClaimed: boolean;
};

function guardBreaches(before: GuardMetrics, after: GuardMetrics) {
  const breaches: GuardBreach[] = [];
  const unavailable: (keyof GuardMetrics)[] = [];
  for (const metric of ['frictionMean', 'revertRate', 'toolErrorRate'] as const) {
    const b = before[metric];
    const a = after[metric];
    if (b === null || a === null) {
      unavailable.push(metric);
      continue;
    }
    if (a - b > GUARD_RISE_THRESHOLD) {
      breaches.push({ after: a, before: b, metric });
    }
  }
  return { breaches, unavailable };
}

/**
 * Compares one stored projection against the actuals of its target period.
 *
 * Pure — the whole point. Everything time- or data-dependent is a parameter, so
 * the interesting cases (open period, thin data, a win with a rising revert
 * rate) are unit tests rather than something you can only see in production
 * once a month has closed.
 *
 * `actuals` is nullable because "no rows at all" and "not enough rows" are the
 * same answer: not yet measurable.
 */
export function realizeProjection(
  projection: StoredProjection,
  actuals: PostPeriodActuals | null,
  now: Date,
): Realization {
  const claim = PROJECTION_CLAIMS[projection.claimType];
  const base: Omit<Realization, 'reason' | 'status'> = {
    actualValue: null,
    guardBreaches: [],
    guardUnavailable: [],
    outcomeFlagged: false,
    projection,
    realizedValue: null,
    wentBetterThanClaimed: false,
  };

  if (now < projection.periodEnd) {
    return {
      ...base,
      reason: 'The period this projection covers has not closed yet.',
      status: 'period_open',
    };
  }
  if (actuals === null || actuals.volume < claim.minPostPeriodVolume) {
    const seen = actuals?.volume ?? 0;
    return {
      ...base,
      reason: `Not yet measurable — ${seen} ${claim.volumeNoun} in the period, ${claim.minPostPeriodVolume} needed before a delta means anything.`,
      status: 'not_yet_measurable',
    };
  }

  const realizedValue =
    claim.realizedQuantity === 'reduction'
      ? projection.baselineValue - actuals.actualValue
      : actuals.actualValue;

  const status: RealizationStatus =
    realizedValue < projection.projectedLow
      ? 'below_range'
      : realizedValue > projection.projectedHigh
        ? 'above_range'
        : 'within_range';

  const { breaches, unavailable } = guardBreaches(projection.guardBaseline, actuals.guard);
  const wentBetterThanClaimed =
    claim.betterWhen === 'above' ? status === 'above_range' : status === 'below_range';

  const guardNote =
    breaches.length > 0
      ? ` Outcomes worsened over the same period (${breaches.map((b) => b.metric).join(', ')}) — this is not a clean win.`
      : '';

  const rangeNote =
    status === 'within_range'
      ? 'Realized inside the projected range.'
      : status === 'above_range'
        ? 'Realized above the projected range.'
        : 'Realized below the projected range.';

  return {
    ...base,
    actualValue: actuals.actualValue,
    guardBreaches: breaches,
    guardUnavailable: unavailable,
    // Flagged whenever outcomes degraded, regardless of which way the number
    // went: the guard's job is to make sure a degradation is never invisible
    // behind a favourable headline number.
    outcomeFlagged: breaches.length > 0,
    realizedValue,
    reason: `${rangeNote}${guardNote}`,
    status,
    wentBetterThanClaimed,
  };
}

/**
 * The versions active whenever a claim is recorded. Recorded on every projection
 * so realization can tell "the recommendation worked" apart from "we re-tuned
 * the scorer between the claim and the check".
 *
 * Derived from the registry rather than listed, so a new scorer is covered by a
 * claim's provenance the moment it exists. A hand-written pair went stale twice
 * over: the guard metrics a claim records already depend on more scorers than
 * the two that were named, and a realization replayed against an unrecorded
 * version cannot tell a re-tune from a result.
 *
 * The judge's registry version is a floor rather than its true identity (see
 * `SCORERS`), so what lands here is "the judge revision the registry knew about
 * at claim time" — still the right provenance for a claim, which is made by a
 * page and not by a judge.
 */
function activeScorerVersions(): Record<string, number> {
  return Object.fromEntries(SCORER_NAMES.map((name) => [name, SCORERS[name].version]));
}

function toStored(row: {
  baselineValue: number;
  baselineWindowDays: number;
  claimType: string;
  createdAt: Date;
  guardBaseline: Prisma.JsonValue;
  id: string;
  metadata: Prisma.JsonValue;
  periodEnd: Date;
  periodStart: Date;
  priceTableVersion: string | null;
  projectedHigh: number;
  projectedLow: number;
  scorerVersions: Prisma.JsonValue;
  segment: string;
  unit: string;
}): StoredProjection {
  const guard = (row.guardBaseline ?? {}) as Partial<GuardMetrics>;
  return {
    baselineValue: row.baselineValue,
    baselineWindowDays: row.baselineWindowDays,
    claimType: row.claimType as ProjectionClaimType,
    createdAt: row.createdAt,
    guardBaseline: {
      frictionMean: guard.frictionMean ?? null,
      revertRate: guard.revertRate ?? null,
      toolErrorRate: guard.toolErrorRate ?? null,
    },
    id: row.id,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    periodEnd: row.periodEnd,
    periodStart: row.periodStart,
    priceTableVersion: row.priceTableVersion,
    projectedHigh: row.projectedHigh,
    projectedLow: row.projectedLow,
    scorerVersions: (row.scorerVersions ?? {}) as Record<string, number>,
    segment: row.segment,
    unit: row.unit as ProjectionUnit,
  };
}

/**
 * Records a batch of claims and hands back the registered objects a claim
 * surface renders from.
 *
 * **First claim wins** on `(claim_type, segment, period_start)`, and is never
 * rewritten — see the comment in the body for why that is a correctness rule and
 * not a preference. Callers day-truncate `periodStart` for rolling windows so
 * that key has something stable to bite on (see `startOfUtcDay`).
 *
 * Ranges are normalized rather than validated away — a caller that passes them
 * the wrong way round gets a valid range, not a claim that renders backwards.
 *
 * Returns one registered claim per input, **in input order**, so a caller can
 * pair each claim with the recommendation it was made about by position.
 */
export async function recordProjections(
  inputs: ProjectionInput[],
): Promise<RegisteredProjection[]> {
  if (inputs.length === 0) {
    return [];
  }
  const db = getPrisma();
  const scorerVersions = activeScorerVersions();

  // A projection is a claim made at a point in time, so the FIRST claim for a
  // (claim, segment, period) wins and is never rewritten. Two reasons, and the
  // second is the important one:
  //
  //  - Correctness. These pages re-render on every request, and the calendar-month
  //    claim keys on the month start. An upsert would rewrite that row on every
  //    view, so the "projection" compared against actuals at month end would be
  //    the estimate made on the last day of the month — when it already knew the
  //    answer. The claim would validate itself and always look accurate.
  //  - Cost. force-dynamic pages wrote one row per claim per request. Now a repeat
  //    view is a single read.
  //
  // A claim that was wrong stays on the record. That is the point of a registry
  // whose job is "what did we say at the time".
  const keyOf = (row: { claimType: string; periodStart: Date; segment: string }) =>
    `${row.claimType}\u0000${row.segment}\u0000${row.periodStart.toISOString()}`;

  const keys = inputs.map((input) => ({
    claimType: input.claimType,
    periodStart: input.periodStart,
    segment: input.segment,
  }));
  const existing = await db.projection.findMany({ where: { OR: keys } });
  const seen = new Set(existing.map(keyOf));

  const fresh = inputs.filter((input) => !seen.has(keyOf(input)));

  if (fresh.length > 0) {
    await db.projection.createMany({
      data: fresh.map((input) => {
        const claim = PROJECTION_CLAIMS[input.claimType];
        return {
          baselineValue: input.baselineValue,
          baselineWindowDays: input.baselineWindowDays,
          claimType: input.claimType,
          guardBaseline: { ...input.guardBaseline } as Prisma.InputJsonValue,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          periodEnd: input.periodEnd,
          periodStart: input.periodStart,
          priceTableVersion: input.priceTableVersion ?? null,
          projectedHigh: Math.max(input.projectedLow, input.projectedHigh),
          projectedLow: Math.min(input.projectedLow, input.projectedHigh),
          scorerVersions: scorerVersions as Prisma.InputJsonValue,
          segment: input.segment,
          unit: claim.unit,
        };
      }),
      // Concurrent renders race on the same key; the loser simply reads it back.
      skipDuplicates: true,
    });
  }

  // Read back rather than trusting the write: for a key that already existed the
  // stored claim is the one that matters, and `createMany` returns a count, not
  // rows. Re-keyed into input order so callers can pair a claim with the
  // recommendation it came from by position.
  const rows = await db.projection.findMany({ where: { OR: keys } });
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));

  return inputs.flatMap((input) => {
    const row = byKey.get(keyOf(input));
    return row === undefined ? [] : [toStored(row) as RegisteredProjection];
  });
}

/** Single-claim convenience over `recordProjections`. */
export async function recordProjection(input: ProjectionInput): Promise<RegisteredProjection> {
  const [only] = await recordProjections([input]);
  // recordProjections returns one row per input — the stored claim, which for a
  // repeat call is the one made first. Throwing rather than asserting non-null:
  // an empty result would mean the read-back found neither an existing claim nor
  // the one just inserted.
  if (!only) {
    throw new Error(`Failed to record projection for claim ${input.claimType}`);
  }
  return only;
}

/**
 * Prior projections of one claim whose target period has closed — the input to
 * the realization panels. Ordered newest-first.
 */
export async function listClosedProjections(
  claimType: ProjectionClaimType,
  now: Date,
  limit = 12,
): Promise<StoredProjection[]> {
  const rows = await getPrisma().projection.findMany({
    orderBy: { periodStart: 'desc' },
    take: limit,
    where: { claimType, periodEnd: { lte: now } },
  });
  return rows.map(toStored);
}

/**
 * UTC midnight of a date. Rolling-window claims re-render constantly; without a
 * truncated `period_start` the unique key would admit a new row per page view
 * and the registry would fill with near-duplicates of the same claim.
 */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Minimum width of a projected range, as a fraction of its midpoint.
 *
 * A claim built from a single estimator has no spread to report, and the
 * temptation is then to write the point estimate into both ends — which is a
 * point estimate wearing a range's clothing, and reads to a user as far more
 * precision than a trailing-run-rate extrapolation has. Every range is widened
 * to at least this, so "range, not point estimate" is a property of the data
 * rather than of the caller remembering.
 */
export const MIN_RANGE_FRACTION = 0.25;

/**
 * Builds a projected range from one or more independent estimators of the same
 * quantity — e.g. a trailing run rate and a month-to-date pace. Their spread is
 * the honest uncertainty; where they agree (or there is only one), the range is
 * widened to `MIN_RANGE_FRACTION` of the midpoint.
 */
export function rangeFrom(estimates: number[]): { high: number; low: number } {
  const usable = estimates.filter((n) => Number.isFinite(n));
  if (usable.length === 0) {
    return { high: 0, low: 0 };
  }
  const low = Math.min(...usable);
  const high = Math.max(...usable);
  const mid = (low + high) / 2;
  const minWidth = Math.abs(mid) * MIN_RANGE_FRACTION;
  if (high - low >= minWidth) {
    return { high, low };
  }
  return { high: mid + minWidth / 2, low: Math.max(0, mid - minWidth / 2) };
}
