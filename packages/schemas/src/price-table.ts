import { z } from 'zod';

const ModelPriceSchema = z.object({
  cache_read_per_mtok: z.number().nonnegative(),
  cache_write_per_mtok: z.number().nonnegative(),
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
});

/**
 * The second cost dimension (P14-015): agents billed per **request** rather than
 * per token.
 *
 * Every table before this one assumed the same denominator — tokens in, tokens
 * out, a rate per million. That is the whole billing model for the API-metered
 * agents, and none of it applies to a seat-licensed one: the seat carries a
 * monthly allowance of requests, each interaction spends allowance equal to the
 * model's multiplier, and only what spills past the allowance is charged, at a
 * flat per-request rate. Filling `prices` with the underlying vendors' per-token
 * rates for such an agent would invent a number nobody is billed, so the table
 * gains a dimension instead of being coerced into the wrong one.
 *
 * Optional, and read only by callers that ask for it, so a token-priced table is
 * unchanged and unaffected. A request-priced table needs no `prices` rows at all
 * — `prices: {}` was already valid.
 *
 * **What a number computed from this is, and is not.** `overage_usd_per_request`
 * is the *marginal* rate past the allowance. A seat still inside its monthly
 * allowance pays **zero** additional dollars for the request, and allowance is
 * monthly, per seat, and not observable from an event stream. So any dollar
 * figure derived here is an **imputed** cost at the marginal rate — what the
 * usage would cost if it were all overage — never billed spend, and callers must
 * label it as such. `included_requests_per_seat_month` is carried so a surface
 * can show allowance consumption (`180 / 300`) next to it, which is the honest
 * denominator for the dollar figure.
 */
const RequestPricingSchema = z.object({
  /**
   * Plan/tier name → requests a seat on that plan includes per month. Plan names
   * are the vendor's own; nothing keys off them, they are for display and for
   * sizing an imputed figure against a real allowance.
   */
  included_requests_per_seat_month: z.record(z.string(), z.number().nonnegative()),
  /**
   * Model → allowance units one request on that model spends. `0` is a real,
   * meaningful value (a model included at no allowance cost, so genuinely free);
   * a model ABSENT from this map is unknown and must not be priced, exactly as an
   * absent `prices` row is.
   */
  multipliers: z.record(z.string(), z.number().nonnegative()),
  /** USD per allowance unit once the seat's monthly allowance is exhausted. */
  overage_usd_per_request: z.number().nonnegative(),
});

export const PriceTableSchema = z.object({
  generated_at: z.iso.datetime({ offset: true }),
  prices: z.record(z.string(), ModelPriceSchema),
  request_pricing: RequestPricingSchema.optional(),
  version: z.string(),
});

export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export type PriceTable = z.infer<typeof PriceTableSchema>;
export type RequestPricing = z.infer<typeof RequestPricingSchema>;

/**
 * True when this agent is billed per request rather than per token — the one
 * check callers should branch on, so "request-priced" stays a property of the
 * table and never a hard-coded agent name.
 */
export function isRequestPriced(
  table: PriceTable,
): table is PriceTable & { request_pricing: RequestPricing } {
  return table.request_pricing !== undefined;
}

/**
 * Imputed marginal USD for one request on `model`, or `undefined` when the table
 * prices no such model.
 *
 * `undefined` — not `0` — is the unknown case, and the distinction is the point:
 * a multiplier of `0` means the request is genuinely free (an included model),
 * while an unknown model means we cannot say. Collapsing the two would let a
 * model we have never heard of read as "free" on a dashboard.
 */
export function requestCostUsd(model: string, pricing: RequestPricing): number | undefined {
  const multiplier = pricing.multipliers[model];
  return multiplier === undefined ? undefined : multiplier * pricing.overage_usd_per_request;
}
