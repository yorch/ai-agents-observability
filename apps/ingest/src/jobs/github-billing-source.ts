import { createGitHubClient } from '@ai-agents-observability/github';
import type { Logger } from 'pino';

import type { BillingSource } from './reconcile-cost';

/**
 * ─── What this talks to, and how that was established ───────────────────────
 *
 * GitHub's **AI-credit usage report** is the vendor-side ground truth for spend
 * on GitHub's AI products. All three scopes share one response shape:
 *
 *   GET /organizations/{org}/settings/billing/ai_credit/usage
 *   GET /enterprises/{enterprise}/settings/billing/ai_credit/usage
 *   GET /users/{username}/settings/billing/ai_credit/usage
 *
 * Sources, all retrieved **2026-08-27**:
 *  - REST reference, all three endpoints, query params and response schema:
 *    https://docs.github.com/en/rest/billing/usage
 *  - Enterprise variant (adds `organization` / `cost_center_id` filters, and the
 *    only one documented to work with a GitHub App token — "read access to
 *    enterprise billing"):
 *    https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage
 *  - Auth: "You authenticate using a personal access token (classic). The
 *    billing usage endpoints do not support fine-grained personal access
 *    tokens." — https://docs.github.com/en/billing/tutorials/automate-usage-reporting
 *  - What AI credits are (1 credit = $0.01 USD; metered on input, output and
 *    cached tokens; completions and next-edit-suggestions are NOT metered):
 *    https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
 *
 * **Everything predating 2026-06-01 is wrong about this API's subject.** On that
 * date GitHub replaced premium requests (a per-request unit) with token-metered
 * AI credits. The `…/premium_request/usage` sibling endpoint still exists and
 * still returns data, but only for the legacy cohort — "Copilot Pro / Pro+
 * subscribers on an existing annual plan who remained on legacy premium
 * request-based billing after June 1, 2026" (see `tasks/P14-015-…`). This source
 * reads **`ai_credit` only**: it is the denominator our price tables are
 * transcribed in, and mixing the two would add requests to dollars.
 *
 * ─── Shape ─────────────────────────────────────────────────────────────────
 *
 * - **Granularity is a calendar period, not a session or a seat.** The query
 *   takes `year` / `month` / `day`; omitting `day` returns the whole month,
 *   which is exactly the window `reconcile-cost` reconciles.
 * - **The response body carries no per-user breakdown.** `user`, `model`,
 *   `product` (and, on the enterprise scope, `organization` and
 *   `cost_center_id`) are *request filters* that are echoed back — one request
 *   returns one aggregate. Attributing spend to our users would mean one request
 *   per user per month plus a GitHub-login↔user join, and would still not
 *   reconcile: see `fetchBilledCost` for why we deliberately do not.
 * - **Not documented as paginated** — no `page` / `per_page` parameter and no
 *   `has_more` field on this endpoint (unlike the Anthropic cost report). We do
 *   not invent a pagination loop for it.
 * - **Retention: the past 24 months only.** Reconciliation always reads the
 *   previous calendar month, so this never binds.
 * - Rate limits are not stated for these endpoints specifically; the standard
 *   REST limits apply, and 429 / 403-with-exhausted-quota are surfaced as a
 *   named error rather than swallowed (a swallowed one becomes a $0 vendor
 *   figure, which reads as 100% drift).
 */

/** `X-GitHub-Api-Version` the AI-credit endpoints were documented under. */
const GITHUB_API_VERSION = '2026-03-10';

/**
 * Agent types whose model spend lands on a GitHub bill. Kept as a set rather
 * than an `if` so adding a second one is data, not control flow: GitHub meters
 * AI credits for "third-party coding agents" too, so this is not permanently a
 * single-entry set. Every other agent type returns `null` without a request →
 * reconciliation records no drift for it, exactly as before this source existed.
 */
const GITHUB_BILLED_AGENT_TYPES: ReadonlySet<string> = new Set(['COPILOT']);

export type GitHubBillingScopeKind = 'enterprise' | 'organization' | 'user';

type RouteSpec = { param: string; route: string };

const ROUTES: Record<GitHubBillingScopeKind, RouteSpec> = {
  enterprise: {
    param: 'enterprise',
    route: 'GET /enterprises/{enterprise}/settings/billing/ai_credit/usage',
  },
  organization: {
    param: 'org',
    route: 'GET /organizations/{org}/settings/billing/ai_credit/usage',
  },
  user: {
    param: 'username',
    route: 'GET /users/{username}/settings/billing/ai_credit/usage',
  },
};

/** One line of the usage report. Amounts are USD; quantities are AI credits. */
type UsageItem = {
  discountAmount?: number;
  grossAmount?: number;
  model?: string;
  netAmount?: number;
  pricePerUnit?: number;
  product?: string;
  sku?: string;
  unitType?: string;
};

type AiCreditUsageReport = { usageItems?: UsageItem[] | null };

export type GitHubBillingConfig = {
  /** Injectable fetch, for tests. Passed straight through to the shared client. */
  fetch?: typeof globalThis.fetch;
  /** GHES origin, e.g. `https://github.example.com`. Omit for github.com. */
  host?: string;
  logger?: Logger;
  /**
   * Optional `product` filter. Unset → every AI-credit product on the account.
   * See the over-count caveat on `fetchBilledCost`.
   */
  product?: string;
  /** Organization login, enterprise slug, or username — matching `scopeKind`. */
  scope: string;
  scopeKind: GitHubBillingScopeKind;
  /**
   * Classic PAT with billing read access (org owner / billing manager /
   * enterprise admin). Fine-grained PATs are explicitly unsupported by these
   * endpoints; only the enterprise scope additionally accepts a GitHub App token.
   */
  token: string;
};

/**
 * Is this failure "come back later" rather than "you may not read this"?
 *
 * Exported for its own test: driving a 429 end-to-end through the client takes
 * ~28 s of the shared Octokit distribution's *own* backoff (it bundles the retry
 * and throttling plugins, so a rate limit is retried several times before our
 * code ever sees it — our error is the terminal case). A test that waits that
 * long to assert a two-line predicate is a test nobody runs.
 */
export function isRateLimited(
  status: number,
  headers: Record<string, unknown> | undefined,
): boolean {
  if (status === 429) {
    return true;
  }
  // GitHub reports primary-limit exhaustion as 403 with the remaining counter at
  // zero, and secondary limits as 403 with a Retry-After.
  if (status !== 403) {
    return false;
  }
  const remaining = headers?.['x-ratelimit-remaining'];
  return remaining === '0' || remaining === 0 || headers?.['retry-after'] !== undefined;
}

/**
 * Vendor-cost source backed by GitHub's AI-credit usage report, for
 * reconciliation against the client-computed `SUM(events.cost_usd)`.
 *
 * **Attribution is org-wide (or enterprise-wide, or one user's personal
 * account) — never per developer.** The response is a single aggregate for the
 * period; there is no per-user breakdown to join our sessions onto. Emitting a
 * per-user reconciliation off it would be fabricated, so this returns exactly
 * one figure per (agentType, month) and `reconcile-cost` compares it against the
 * matching org-wide sum. That is the honest claim the data supports.
 *
 * **Two things make the returned figure an over-count, both by construction:**
 *  1. AI credits are metered across *all* of GitHub's AI products — Copilot
 *     Chat, Copilot CLI, the cloud agent, Copilot Spaces, Spark, third-party
 *     coding agents. Our `COPILOT` events come from the CLI alone. Set
 *     `product` to narrow it; the exact accepted values are not enumerated in
 *     the docs, so every run logs the distinct `product` / `sku` values it saw
 *     for an operator to read off a real response.
 *  2. The bill covers every seat on the account, including developers who never
 *     installed our hook.
 *
 * **We sum `grossAmount`, not `netAmount`.** `netAmount` is what GitHub invoices
 * after the pooled included allowance (1,900 credits/user/month on Business,
 * 3,900 on Enterprise) is discounted off; `grossAmount` is the list value of the
 * metered usage. Our price tables are transcribed from GitHub's *published
 * per-model rates*, so a client-computed figure is a list-price estimate and
 * only `grossAmount` is the like-for-like comparand — reconciling against
 * `netAmount` would report ~100% drift for any account still inside its
 * allowance and call it a pricing error. Both are logged.
 */
export class GitHubBillingSource implements BillingSource {
  private readonly client: ReturnType<typeof createGitHubClient>;
  private readonly logger: Logger | undefined;
  private readonly product: string | undefined;
  private readonly scope: string;
  private readonly scopeKind: GitHubBillingScopeKind;

  constructor(config: GitHubBillingConfig) {
    this.client = createGitHubClient({
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.host ? { host: config.host } : {}),
      token: config.token,
    });
    this.logger = config.logger;
    this.product = config.product;
    this.scope = config.scope;
    this.scopeKind = config.scopeKind;
  }

  async fetchBilledCost(agentType: string, year: number, month: number): Promise<number | null> {
    if (!GITHUB_BILLED_AGENT_TYPES.has(agentType)) {
      return null;
    }

    const spec = ROUTES[this.scopeKind];
    let report: AiCreditUsageReport;
    try {
      const res = await this.client.request(spec.route, {
        headers: { 'X-GitHub-Api-Version': GITHUB_API_VERSION },
        month,
        year,
        [spec.param]: this.scope,
        ...(this.product ? { product: this.product } : {}),
      });
      report = res.data as AiCreditUsageReport;
    } catch (err) {
      // `@octokit/request-error` v6 dropped the top-level `.headers` (it now
      // carries the *request* headers where it survives at all); the response's
      // rate-limit headers live under `.response`. Read that first, or every
      // throttled month is misreported as a permissions failure.
      const { response, status } = err as {
        response?: { headers?: Record<string, unknown> };
        status?: number;
      };
      const headers = response?.headers;
      const context = `${this.scopeKind} ${this.scope} ${year}-${String(month).padStart(2, '0')}`;
      if (status !== undefined && isRateLimited(status, headers)) {
        // Deliberately a throw, not a `null`. `null` means "no ground truth
        // exists for this agent", and reconcile-cost records zero drift for it —
        // which would make a throttled month indistinguishable from a clean one.
        throw new Error(`GitHub ai_credit usage: rate limited (${status}) for ${context}`);
      }
      throw new Error(
        `GitHub ai_credit usage responded ${status ?? 'error'} for ${context}: ${
          err instanceof Error ? err.message.slice(0, 200) : String(err)
        }`,
      );
    }

    const items = report.usageItems ?? [];
    let gross = 0;
    let net = 0;
    const products = new Set<string>();
    const skus = new Set<string>();
    for (const item of items) {
      if (Number.isFinite(item.grossAmount)) {
        gross += item.grossAmount as number;
      }
      if (Number.isFinite(item.netAmount)) {
        net += item.netAmount as number;
      }
      if (item.product) {
        products.add(item.product);
      }
      if (item.sku) {
        skus.add(item.sku);
      }
    }

    // An empty period is a real answer ($0 of metered AI credits), not a
    // failure — but it is also what a wrong `product` filter looks like, so say
    // which it was rather than leaving an operator to guess from a zero.
    this.logger?.info(
      {
        agentType,
        grossUsd: gross,
        items: items.length,
        month,
        netUsd: net,
        productFilter: this.product ?? null,
        products: [...products],
        scope: this.scope,
        scopeKind: this.scopeKind,
        skus: [...skus],
        year,
      },
      items.length === 0
        ? 'github ai_credit usage: empty period'
        : 'github ai_credit usage: fetched',
    );

    return gross;
  }
}
