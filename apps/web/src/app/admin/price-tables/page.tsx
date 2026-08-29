import { ADAPTER_AGENT_TYPES } from '@ai-agents-observability/schemas';
import { Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { getConfig } from '@/lib/config';
import { fmtDate } from '@/lib/fmt';
import { requireOrgAdmin } from '@/lib/roles';
import { getUnpricedModels, UNPRICED_WINDOW_DAYS } from '@/lib/unpriced-queries';

export const dynamic = 'force-dynamic';

// Derived from the agent registry (P12-001) so a new adapter's table shows up
// here without a second list to remember. `?agent=` takes the lowercase,
// underscored form that ingest keys its tables on.
const KNOWN_AGENTS = ADAPTER_AGENT_TYPES.map((agent) => agent.toLowerCase());
type AgentName = string;

type ModelPrice = {
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  input_per_mtok: number;
  output_per_mtok: number;
};

/** The second denominator (P14-015). Absent on a purely token-billed agent. */
type RequestPricing = {
  included_requests_per_seat_month: Record<string, number>;
  multipliers: Record<string, number>;
  overage_usd_per_request: number;
};

type PriceTableResult =
  | {
      ok: true;
      generated_at: string;
      prices: Record<string, ModelPrice>;
      request_pricing?: RequestPricing;
      version: string;
    }
  | { ok: false; reason: string };

async function fetchTable(ingestUrl: string, agent: AgentName): Promise<PriceTableResult> {
  try {
    const res = await fetch(`${ingestUrl}/v1/price-table?agent=${agent}`, {
      cache: 'no-store',
    });
    if (res.status === 404) {
      return { ok: false, reason: 'No table configured' };
    }
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, ...data };
  } catch {
    return { ok: false, reason: 'Ingest unreachable' };
  }
}

function fmt(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * The request-denominated dimension (P14-015), for agents billed per request
 * against a monthly seat allowance rather than per token.
 *
 * Rendered as reference, never as spend, and the copy has to carry that: the
 * per-request figure is what one request would cost **past** the allowance, and
 * a seat inside its allowance pays nothing more. Allowance is monthly and
 * per-seat, which no event stream observes, so nothing here is totalled into a
 * dollar figure anywhere in the product — showing the operator the rate is the
 * whole job.
 */
function RequestPricing({
  dict,
  pricing,
}: {
  dict: import('@/i18n/dictionary').Dictionary;
  pricing: RequestPricing;
}) {
  const allowances = Object.entries(pricing.included_requests_per_seat_month);
  const multipliers = Object.entries(pricing.multipliers).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-2 p-4">
      <div>
        <h3 className="text-xs font-semibold text-text">
          {dict.admin.priceTables.requestDenominated}
        </h3>
        <p className="mt-1 text-xs text-text-2">
          This agent also bills per request on some plans: a seat spends its monthly allowance at
          the model&rsquo;s multiplier, and only usage past that allowance is charged, at{' '}
          <span className="font-mono text-text">{fmt(pricing.overage_usd_per_request)}</span> per
          request.{' '}
          {allowances.length > 0 && (
            <>
              Included per seat per month:{' '}
              {allowances
                .map(([plan, n]) => `${plan.replaceAll('_', ' ')} ${n.toLocaleString()}`)
                .join(' · ')}
              .{' '}
            </>
          )}
          Nothing here feeds a cost figure: which denominator a seat is billed on is a property of
          its plan, and how much allowance it has left is monthly and per-seat — neither is
          observable from telemetry, so a dollar total computed here would be imputed, not billed.
        </p>
      </div>
      <Table columns={[{ label: 'Model' }, { align: 'right', label: 'Requests per prompt' }]}>
        {multipliers.map(([model, multiplier]) => (
          <Row key={model}>
            <Cell className="text-xs text-text">{model}</Cell>
            <Cell num className="text-xs text-text-2">
              {multiplier}&times;
            </Cell>
          </Row>
        ))}
      </Table>
    </div>
  );
}

/**
 * Models producing billable tokens that no table prices — every one of those
 * events cost $0. The `unknown_model_surge` alert counts them; this names them,
 * which is the part an operator needs to act.
 *
 * `notTokenBilled` carries the agents that can never be priced per token: those
 * whose table carries request pricing and *no* token rates at all. It used to be
 * derived from an empty `prices` map alone, which was the same set only because
 * Copilot was the one empty table; since P14-015 Copilot has both denominators
 * (GitHub moved it to token-metered AI credits on 2026-06-01 and kept
 * request-billing only for legacy annual plans), so an empty map is no longer
 * what the badge means. Still derived from the fetched tables rather than a
 * hard-coded name, so a genuinely request-only agent needs no edit here.
 */
async function UnpricedModels({
  dict,
  notTokenBilled,
}: {
  dict: import('@/i18n/dictionary').Dictionary;
  notTokenBilled: Set<string>;
}) {
  const rows = await getUnpricedModels();

  return (
    <Card
      title={dict.admin.priceTables.unpricedModels}
      caption={`Models seen in the last ${UNPRICED_WINDOW_DAYS} days that carried tokens but resolved to no price row — those events were costed at $0. Add the actionable ones to the agent's table below.`}
      flush={rows.length > 0}
    >
      {rows.length === 0 ? (
        <CardEmpty>{dict.admin.priceTables.emptyUnpriced}</CardEmpty>
      ) : (
        <Table
          columns={[
            { label: 'Agent' },
            { label: 'Model' },
            { align: 'right', label: 'Events' },
            { align: 'right', label: 'Input tokens' },
            { align: 'right', label: 'Output tokens' },
            { label: 'Last seen' },
          ]}
        >
          {rows.map((row) => {
            const agent = row.agentType.toLowerCase();
            return (
              <Row key={`${row.agentType}:${row.model}`}>
                <Cell className="text-xs text-text-2 font-mono">{agent}</Cell>
                <Cell className="text-xs text-text font-mono">
                  {row.model}
                  {notTokenBilled.has(agent) && (
                    <span className="ml-2 font-sans text-text-3">
                      — billed per request, not per token
                    </span>
                  )}
                </Cell>
                <Cell num className="text-xs text-text-2">
                  {row.events.toLocaleString()}
                </Cell>
                <Cell num className="text-xs text-text-3">
                  {row.inputTokens.toLocaleString()}
                </Cell>
                <Cell num className="text-xs text-text-3">
                  {row.outputTokens.toLocaleString()}
                </Cell>
                <Cell className="text-xs text-text-3">{fmtDate(row.lastSeen)}</Cell>
              </Row>
            );
          })}
        </Table>
      )}
    </Card>
  );
}

export default async function PriceTablesPage() {
  await requireOrgAdmin();
  const { dict } = await getTranslations();

  const { ingestUrl } = getConfig();

  if (!ingestUrl) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">
          Price tables
        </h1>
        <div className="rounded-lg border border-warn-line bg-warn-soft p-4 text-sm">
          <p className="font-medium text-warn">{dict.admin.priceTables.ingestUrlMissing}</p>
          <p className="mt-1 text-text-2">
            Set the{' '}
            <code className="font-mono text-xs bg-surface-2 px-1 py-0.5 rounded">
              {dict.admin.priceTables.ingestUrl}
            </code>{' '}
            environment variable in the web app to point at the ingest service (e.g.{' '}
            <code className="font-mono text-xs bg-surface-2 px-1 py-0.5 rounded">
              http://ingest:3001
            </code>
            ) to view current price tables.
          </p>
        </div>
      </div>
    );
  }

  const results = await Promise.all(
    KNOWN_AGENTS.map(async (agent) => ({ agent, result: await fetchTable(ingestUrl, agent) })),
  );

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">
          Price tables
        </h1>
        <p className="text-sm text-text-2">
          Per-agent LLM pricing used for cost computation. Tables are JSON fixtures loaded by the
          ingest service at startup. Update the files under{' '}
          <code className="font-mono text-xs">{dict.admin.priceTables.dataPath}</code> and redeploy
          to change pricing.
        </p>
      </div>

      <UnpricedModels
        dict={dict}
        notTokenBilled={
          new Set(
            results
              .filter(
                ({ result }) =>
                  result.ok &&
                  result.request_pricing !== undefined &&
                  Object.keys(result.prices).length === 0,
              )
              .map(({ agent }) => agent),
          )
        }
      />

      {results.map(({ agent, result }) => (
        <section key={agent} className="space-y-3">
          <h2 className="flex items-center gap-3 text-sm font-semibold text-text">
            <span className="font-mono">{agent}</span>
            {result.ok && (
              <span className="text-xs text-text-3 font-normal">
                v{result.version} · generated {fmtDate(new Date(result.generated_at))}
              </span>
            )}
          </h2>

          {!result.ok ? (
            <p className="text-sm text-text-3 italic">{result.reason}</p>
          ) : Object.keys(result.prices).length === 0 ? (
            <CardEmpty>{dict.admin.priceTables.empty}</CardEmpty>
          ) : (
            <Table
              columns={[
                { label: 'Model' },
                { align: 'right', label: 'Input /Mtok' },
                { align: 'right', label: 'Output /Mtok' },
                { align: 'right', label: 'Cache read /Mtok' },
                { align: 'right', label: 'Cache write /Mtok' },
              ]}
            >
              {Object.entries(result.prices).map(([model, p]) => (
                <Row key={model}>
                  <Cell className="text-xs text-text">{model}</Cell>
                  <Cell num className="text-xs text-text-2">
                    {fmt(p.input_per_mtok)}
                  </Cell>
                  <Cell num className="text-xs text-text-2">
                    {fmt(p.output_per_mtok)}
                  </Cell>
                  <Cell num className="text-xs text-text-3">
                    {fmt(p.cache_read_per_mtok)}
                  </Cell>
                  <Cell num className="text-xs text-text-3">
                    {fmt(p.cache_write_per_mtok)}
                  </Cell>
                </Row>
              ))}
            </Table>
          )}

          {result.ok && result.request_pricing && (
            <RequestPricing dict={dict} pricing={result.request_pricing} />
          )}
        </section>
      ))}
    </div>
  );
}
