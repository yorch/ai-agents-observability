import type { Logger } from 'pino';

import type { BillingSource } from './reconcile-cost';

// Anthropic bills for Claude Code, so CLAUDE_CODE is the only agent_type with a
// vendor-cost source. Every other agent_type (OPENCODE, CODEX, …) returns null →
// reconciliation records zero drift for it.
const CLAUDE_CODE_AGENT_TYPE = 'CLAUDE_CODE';
const ANTHROPIC_VERSION = '2023-06-01';
// Defensive pagination cap — a single month's report can't legitimately exceed
// this many pages (guards against a bad next_page loop). We don't set an
// explicit `limit`: the server's default page size is fine, and pagination
// collects the whole month regardless, so there's no reason to risk a value the
// API might reject.
const MAX_PAGES = 40;

export type AnthropicBillingConfig = {
  // Admin API key, `sk-ant-admin...` (sent as x-api-key).
  adminKey: string;
  // Anthropic API base, e.g. https://api.anthropic.com.
  baseUrl: string;
  logger?: Logger;
  // Optional: restrict cost to a single workspace's spend.
  workspaceId?: string;
};

type CostResult = {
  // Decimal string in the currency's MINOR unit — cents for USD (see class doc).
  amount: string;
  currency: string;
  workspace_id: string | null;
};
type CostBucket = { results: CostResult[] | null };
type CostReport = {
  data: CostBucket[] | null;
  has_more: boolean;
  next_page: string | null;
};

/**
 * Vendor-cost source backed by Anthropic's Admin **Cost Report API**
 * (`GET /v1/organizations/cost_report`). Sums the organization's billed cost for
 * a calendar month and returns it in **USD**, to reconcile against the
 * client-computed `SUM(events.cost_usd)`.
 *
 * Two API specifics this handles:
 *  - **`amount` is a decimal string in the currency's minor unit** (cents for
 *    USD) — per the API docs, `"123.45"` USD represents `$1.23`. We divide by
 *    100 so the figure matches `events.cost_usd` (dollars).
 *  - Results **paginate** via `has_more` / `next_page`.
 *
 * Scope caveat: the Cost Report is **org-wide** — it can't separate Claude Code
 * usage from other Anthropic API usage on the same organization. Point
 * `workspaceId` at a dedicated Claude Code workspace to scope it; otherwise the
 * returned figure is the org's total Anthropic spend (an over-count when the org
 * also calls the API directly), and reconciliation drift will reflect that.
 */
export class AnthropicBillingSource implements BillingSource {
  private readonly adminKey: string;
  private readonly baseUrl: string;
  private readonly logger: Logger | undefined;
  private readonly workspaceId: string | undefined;

  constructor(config: AnthropicBillingConfig) {
    this.adminKey = config.adminKey;
    this.baseUrl = config.baseUrl;
    this.logger = config.logger;
    this.workspaceId = config.workspaceId;
  }

  async fetchBilledCost(agentType: string, year: number, month: number): Promise<number | null> {
    if (agentType !== CLAUDE_CODE_AGENT_TYPE) {
      return null;
    }

    // Month window [start, end) in UTC. `month` is 1-based (matching the caller).
    const startingAt = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const endingAt = new Date(Date.UTC(year, month, 1)).toISOString();

    let totalMinorUnits = 0;
    let page: string | null = null;

    for (let i = 0; i < MAX_PAGES; i++) {
      const url = new URL('/v1/organizations/cost_report', this.baseUrl);
      url.searchParams.set('starting_at', startingAt);
      url.searchParams.set('ending_at', endingAt);
      url.searchParams.set('bucket_width', '1d');
      // Grouping by workspace is only needed when filtering to one; without it
      // each bucket carries a single aggregate result (org total).
      if (this.workspaceId) {
        url.searchParams.append('group_by', 'workspace_id');
      }
      if (page) {
        url.searchParams.set('page', page);
      }

      const res = await fetch(url.toString(), {
        headers: {
          'anthropic-version': ANTHROPIC_VERSION,
          'x-api-key': this.adminKey,
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Anthropic cost_report responded ${res.status} for ${year}-${month}: ${body.slice(0, 200)}`,
        );
      }

      const report = (await res.json()) as CostReport;
      for (const bucket of report.data ?? []) {
        for (const result of bucket.results ?? []) {
          // When scoped to a workspace, skip other workspaces' cost (the default
          // workspace reports a null id, so a configured id excludes it).
          if (this.workspaceId && result.workspace_id !== this.workspaceId) {
            continue;
          }
          const minorUnits = Number(result.amount);
          if (Number.isFinite(minorUnits)) {
            totalMinorUnits += minorUnits;
          }
        }
      }

      if (!report.has_more || !report.next_page) {
        this.logger?.debug(
          { month, pages: i + 1, workspaceId: this.workspaceId, year },
          'anthropic cost_report: fetched',
        );
        // Minor units (cents) → dollars.
        return totalMinorUnits / 100;
      }
      page = report.next_page;
    }

    // Ran out of page budget — surface it rather than returning a partial sum
    // that would masquerade as a real (low) vendor cost and inflate drift.
    throw new Error(
      `Anthropic cost_report: exceeded ${MAX_PAGES} pages for ${year}-${month} (unexpected)`,
    );
  }
}
