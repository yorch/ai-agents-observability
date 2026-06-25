import { getConfig } from '@/lib/config';
import { requireOrgAdmin } from '@/lib/roles';

export const dynamic = 'force-dynamic';

const KNOWN_AGENTS = ['claude_code', 'codex', 'opencode'] as const;
type AgentName = (typeof KNOWN_AGENTS)[number];

type ModelPrice = {
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  input_per_mtok: number;
  output_per_mtok: number;
};

type PriceTableResult =
  | { ok: true; generated_at: string; prices: Record<string, ModelPrice>; version: string }
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

export default async function PriceTablesPage() {
  await requireOrgAdmin();

  const { ingestUrl } = getConfig();

  if (!ingestUrl) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">
          Price tables
        </h1>
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm">
          <p className="font-medium text-yellow-400">INGEST_URL not configured</p>
          <p className="mt-1 text-text-2">
            Set the{' '}
            <code className="font-mono text-xs bg-surface-2 px-1 py-0.5 rounded">INGEST_URL</code>{' '}
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
          <code className="font-mono text-xs">apps/ingest/src/data/</code> and redeploy to change
          pricing.
        </p>
      </div>

      {results.map(({ agent, result }) => (
        <section key={agent} className="space-y-3">
          <h2 className="flex items-center gap-3 text-sm font-semibold text-text">
            <span className="font-mono">{agent}</span>
            {result.ok && (
              <span className="text-xs text-text-3 font-normal">
                v{result.version} · generated {new Date(result.generated_at).toLocaleDateString()}
              </span>
            )}
          </h2>

          {!result.ok ? (
            <p className="text-sm text-text-3 italic">{result.reason}</p>
          ) : Object.keys(result.prices).length === 0 ? (
            <p className="text-sm text-text-3 italic">
              No models configured (all sessions bill $0)
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface text-left text-xs text-text-3">
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 font-medium text-right">Input /Mtok</th>
                    <th className="px-4 py-2 font-medium text-right">Output /Mtok</th>
                    <th className="px-4 py-2 font-medium text-right">Cache read /Mtok</th>
                    <th className="px-4 py-2 font-medium text-right">Cache write /Mtok</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {Object.entries(result.prices).map(([model, p]) => (
                    <tr key={model} className="hover:bg-surface-2 transition-colors">
                      <td className="px-4 py-2 font-mono text-xs text-text">{model}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-text-2">
                        {fmt(p.input_per_mtok)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-text-2">
                        {fmt(p.output_per_mtok)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-text-3">
                        {fmt(p.cache_read_per_mtok)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-text-3">
                        {fmt(p.cache_write_per_mtok)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
