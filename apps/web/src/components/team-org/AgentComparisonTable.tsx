import { agentDisplayName } from '@ai-agents-observability/schemas';
import { fmtPct, fmtUsd } from '@/lib/fmt';
import type { AgentComparisonRow } from '@/lib/org-queries';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}k`;
  }
  return String(n);
}

// Side-by-side comparison of agent products (agent_type) on cost and quality.
// Single-agent orgs (only Claude Code) still render a one-row table — useful as a
// baseline before a second tool is adopted.
export function AgentComparisonTable({ rows }: { rows: AgentComparisonRow[] }) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-white/70">Agent comparison</h2>
        <p className="text-xs text-white/40">
          Cost efficiency and outcome quality by coding agent · aggregate, visibility-scoped
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-white/40">No agent activity in this window.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-white/40 text-left">
              <th className="pb-2 font-medium">Agent</th>
              <th className="pb-2 font-medium text-right">Sessions</th>
              <th className="pb-2 font-medium text-right">Total cost</th>
              <th className="pb-2 font-medium text-right">Avg cost / session</th>
              <th className="pb-2 font-medium text-right">Median friction</th>
              <th className="pb-2 font-medium text-right">Tool error rate</th>
              <th className="pb-2 font-medium text-right">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((r) => (
              <tr key={r.agentType}>
                <td className="py-2 text-white/80">{agentDisplayName(r.agentType)}</td>
                <td className="py-2 text-right text-white/60">{r.sessions.toLocaleString()}</td>
                <td className="py-2 text-right font-mono">{fmtUsd(r.totalCostUsd)}</td>
                <td className="py-2 text-right font-mono">{fmtUsd(r.avgCostUsd)}</td>
                <td className="py-2 text-right font-mono text-white/60">
                  {r.medianFriction != null ? r.medianFriction.toFixed(2) : '—'}
                </td>
                <td
                  className={`py-2 text-right font-mono ${r.toolErrorRate != null && r.toolErrorRate > 0.1 ? 'text-yellow-300' : 'text-white/60'}`}
                >
                  {r.toolErrorRate != null ? fmtPct(r.toolErrorRate) : '—'}
                </td>
                <td className="py-2 text-right font-mono text-white/60">
                  {fmtTokens(r.totalTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
