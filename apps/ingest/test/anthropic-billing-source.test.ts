import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicBillingSource } from '../src/jobs/anthropic-billing-source';

type CostReport = {
  data: { results: { amount: string; currency: string; workspace_id: string | null }[] }[];
  has_more: boolean;
  next_page: string | null;
};

function jsonResponse(body: CostReport, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeSource(overrides?: { workspaceId?: string }) {
  return new AnthropicBillingSource({
    adminKey: 'sk-ant-admin-test',
    baseUrl: 'https://api.anthropic.example',
    ...(overrides?.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
  });
}

describe('AnthropicBillingSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null (no request) for a non-Claude-Code agent type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const source = makeSource();

    expect(await source.fetchBilledCost('OPENCODE', 2026, 5)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sums the month, converts cents→USD, and sends admin auth + month window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        // 12345.6 + 4400 = 16745.6 cents → $167.456
        data: [
          { results: [{ amount: '12345.6', currency: 'USD', workspace_id: null }] },
          { results: [{ amount: '4400', currency: 'USD', workspace_id: null }] },
        ],
        has_more: false,
        next_page: null,
      }),
    );

    const usd = await makeSource().fetchBilledCost('CLAUDE_CODE', 2026, 5);
    expect(usd).toBeCloseTo(167.456, 6);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe('/v1/organizations/cost_report');
    expect(url.searchParams.get('starting_at')).toBe('2026-05-01T00:00:00.000Z');
    expect(url.searchParams.get('ending_at')).toBe('2026-06-01T00:00:00.000Z');
    expect(url.searchParams.get('bucket_width')).toBe('1d');
    expect(url.searchParams.get('group_by')).toBeNull(); // no workspace filter
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-admin-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('follows next_page pagination and sums across pages', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ results: [{ amount: '100', currency: 'USD', workspace_id: null }] }],
          has_more: true,
          next_page: 'page-2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ results: [{ amount: '200', currency: 'USD', workspace_id: null }] }],
          has_more: false,
          next_page: null,
        }),
      );

    const usd = await makeSource().fetchBilledCost('CLAUDE_CODE', 2026, 1);
    expect(usd).toBeCloseTo(3, 6); // (100 + 200) cents = $3.00
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchSpy.mock.calls[1]?.[0] as string);
    expect(secondUrl.searchParams.get('page')).toBe('page-2');
  });

  it('scopes to a workspace: groups by workspace_id and skips other workspaces', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          {
            results: [
              { amount: '5000', currency: 'USD', workspace_id: 'wrkspc_target' },
              { amount: '9999', currency: 'USD', workspace_id: 'wrkspc_other' },
              { amount: '1', currency: 'USD', workspace_id: null }, // default ws
            ],
          },
        ],
        has_more: false,
        next_page: null,
      }),
    );

    const usd = await makeSource({ workspaceId: 'wrkspc_target' }).fetchBilledCost(
      'CLAUDE_CODE',
      2026,
      5,
    );
    expect(usd).toBeCloseTo(50, 6); // only the 5000-cent target-workspace row
    const url = new URL(fetchSpy.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get('group_by')).toBe('workspace_id');
  });

  it('throws on a non-2xx response rather than reporting a false zero cost', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: [], has_more: false, next_page: null }, 401),
    );

    await expect(makeSource().fetchBilledCost('CLAUDE_CODE', 2026, 5)).rejects.toThrow(/401/);
  });
});
