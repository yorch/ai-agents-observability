import { describe, expect, it, vi } from 'vitest';

import {
  type GitHubBillingConfig,
  GitHubBillingSource,
  isRateLimited,
} from '../src/jobs/github-billing-source';

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

/**
 * Octokit drives a real `fetch`, so the double must be one: a `Response` with a
 * JSON content type, not a hand-rolled object. That also means these tests
 * exercise Octokit's own URL templating and error mapping rather than mocking
 * past them — which is the half most likely to be wrong.
 */
function fakeFetch(
  body: unknown,
  init: { headers?: Record<string, string>; status?: number } = {},
): { calls: string[]; fetch: typeof globalThis.fetch } {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input.toString());
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', ...init.headers },
      status: init.status ?? 200,
    });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

function report(usageItems: UsageItem[]): unknown {
  return { organization: 'acme', timePeriod: { month: 5, year: 2026 }, usageItems };
}

function makeSource(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<GitHubBillingConfig> = {},
): GitHubBillingSource {
  return new GitHubBillingSource({
    fetch: fetchImpl,
    scope: 'acme',
    scopeKind: 'organization',
    token: 'ghp_test',
    ...overrides,
  });
}

describe('GitHubBillingSource', () => {
  it('returns null (and makes no request) for an agent GitHub does not bill', async () => {
    const { calls, fetch } = fakeFetch(report([]));
    const source = makeSource(fetch);

    // Anti-vacuity: the same source DOES answer for COPILOT (asserted below),
    // so these nulls are the mapping working, not a source that answers nothing.
    expect(await source.fetchBilledCost('CLAUDE_CODE', 2026, 5)).toBeNull();
    expect(await source.fetchBilledCost('OPENCODE', 2026, 5)).toBeNull();
    expect(await source.fetchBilledCost('CODEX', 2026, 5)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('sums grossAmount for the requested month and hits the org AI-credit route', async () => {
    const { calls, fetch } = fakeFetch(
      report([
        { grossAmount: 120.5, netAmount: 0, product: 'copilot', sku: 'copilot_cli' },
        { grossAmount: 30.25, netAmount: 10.25, product: 'copilot', sku: 'copilot_chat' },
      ]),
    );

    const usd = await makeSource(fetch).fetchBilledCost('COPILOT', 2026, 5);
    expect(usd).toBeCloseTo(150.75, 6);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0] as string);
    expect(url.pathname).toBe('/organizations/acme/settings/billing/ai_credit/usage');
    expect(url.searchParams.get('year')).toBe('2026');
    expect(url.searchParams.get('month')).toBe('5');
    // No `day` — omitting it is what makes the report cover the whole month.
    expect(url.searchParams.get('day')).toBeNull();
    // No product filter configured → none sent (the over-counting default).
    expect(url.searchParams.get('product')).toBeNull();
  });

  it('sums gross, not net: an account inside its included allowance is not 100% drift', async () => {
    const { fetch } = fakeFetch(
      report([{ discountAmount: 90, grossAmount: 100, netAmount: 10, product: 'copilot' }]),
    );

    expect(await makeSource(fetch).fetchBilledCost('COPILOT', 2026, 5)).toBeCloseTo(100, 6);
  });

  it('routes to the enterprise scope and forwards a product filter', async () => {
    const { calls, fetch } = fakeFetch(report([{ grossAmount: 7, product: 'copilot' }]));

    const usd = await makeSource(fetch, {
      product: 'copilot',
      scope: 'acme-inc',
      scopeKind: 'enterprise',
    }).fetchBilledCost('COPILOT', 2026, 12);

    expect(usd).toBeCloseTo(7, 6);
    const url = new URL(calls[0] as string);
    expect(url.pathname).toBe('/enterprises/acme-inc/settings/billing/ai_credit/usage');
    expect(url.searchParams.get('product')).toBe('copilot');
  });

  it('routes to the user scope', async () => {
    const { calls, fetch } = fakeFetch(report([{ grossAmount: 3.5 }]));

    const usd = await makeSource(fetch, { scope: 'octocat', scopeKind: 'user' }).fetchBilledCost(
      'COPILOT',
      2026,
      1,
    );

    expect(usd).toBeCloseTo(3.5, 6);
    expect(new URL(calls[0] as string).pathname).toBe(
      '/users/octocat/settings/billing/ai_credit/usage',
    );
  });

  it('returns 0 for an empty period rather than throwing', async () => {
    const { fetch } = fakeFetch(report([]));

    expect(await makeSource(fetch).fetchBilledCost('COPILOT', 2026, 5)).toBe(0);
  });

  it('tolerates a partial period: items missing grossAmount contribute nothing', async () => {
    const { fetch } = fakeFetch(
      report([
        { grossAmount: 5, product: 'copilot' },
        { netAmount: 99, product: 'copilot' }, // no grossAmount at all
      ]),
    );

    // 5, not 104 and not NaN — a missing field must not poison the sum.
    expect(await makeSource(fetch).fetchBilledCost('COPILOT', 2026, 5)).toBeCloseTo(5, 6);
  });

  it('throws on an auth failure rather than reporting a false $0 vendor cost', async () => {
    const { fetch } = fakeFetch({ message: 'Bad credentials' }, { status: 401 });

    await expect(makeSource(fetch).fetchBilledCost('COPILOT', 2026, 5)).rejects.toThrow(/401/);
  });

  it('throws on a 403 permissions failure, and does not call it rate limiting', async () => {
    const { fetch } = fakeFetch(
      { message: 'Resource not accessible' },
      { headers: { 'x-ratelimit-remaining': '4999' }, status: 403 },
    );

    const err = await makeSource(fetch)
      .fetchBilledCost('COPILOT', 2026, 5)
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err?.message).toMatch(/responded 403/);
    // Anti-vacuity for the rate-limit branch below: a plain 403 must NOT be
    // reported as throttling, or every permissions bug reads as "retry later".
    expect(err?.message).not.toMatch(/rate limited/);
  });

  it('names rate limiting on an exhausted-quota 403 rather than a permissions error', async () => {
    const { fetch } = fakeFetch(
      { message: 'API rate limit exceeded' },
      // `retry-after: 0` keeps the shared client's own backoff from making this
      // a multi-second test; the classifier is what is under test.
      { headers: { 'retry-after': '0', 'x-ratelimit-remaining': '0' }, status: 403 },
    );

    await expect(makeSource(fetch).fetchBilledCost('COPILOT', 2026, 5)).rejects.toThrow(
      /rate limited \(403\)/,
    );
  });

  describe('isRateLimited', () => {
    it('classifies throttling apart from every other failure', () => {
      // 429 needs no headers at all.
      expect(isRateLimited(429, undefined)).toBe(true);
      // 403 is throttling only with the rate-limit evidence attached...
      expect(isRateLimited(403, { 'x-ratelimit-remaining': '0' })).toBe(true);
      expect(isRateLimited(403, { 'retry-after': '30' })).toBe(true);
      // ...and is a plain permissions failure without it.
      expect(isRateLimited(403, { 'x-ratelimit-remaining': '4999' })).toBe(false);
      expect(isRateLimited(403, undefined)).toBe(false);
      // Anti-vacuity: nothing else is throttling, whatever headers it carries.
      expect(isRateLimited(401, { 'x-ratelimit-remaining': '0' })).toBe(false);
      expect(isRateLimited(404, { 'retry-after': '30' })).toBe(false);
      expect(isRateLimited(500, undefined)).toBe(false);
    });
  });
});
