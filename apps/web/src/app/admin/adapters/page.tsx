import { agentDisplayName } from '@ai-agents-observability/schemas';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

export const dynamic = 'force-dynamic';

// Known adapter agent types — what the hook currently ships. Not every value in the
// AgentType enum is an active adapter (CURSOR, AIDER, COPILOT, WINDSURF are planned).
const ADAPTER_AGENTS = ['CLAUDE_CODE', 'CODEX', 'OPENCODE'] as const;

function fmtRelative(date: Date | null): string {
  if (!date) return 'never';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

function statusBadge(lastSeen: Date | null, sessions7d: number): 'active' | 'stale' | 'inactive' {
  if (!lastSeen || sessions7d === 0) return 'inactive';
  const ageMins = (Date.now() - lastSeen.getTime()) / 60_000;
  if (ageMins > 60 * 24 * 2) return 'stale'; // no activity in 2 days
  return 'active';
}

export default async function AdaptersPage() {
  await requireOrgAdmin();

  const db = getPrisma();
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [counts7d, counts24h, crashes7d, lastSeenRows] = await Promise.all([
    db.session.groupBy({
      _count: { _all: true },
      by: ['agentType'],
      where: { startedAt: { gte: since7d } },
    }),
    db.session.groupBy({
      _count: { _all: true },
      by: ['agentType'],
      where: { startedAt: { gte: since24h } },
    }),
    db.session.groupBy({
      _count: { _all: true },
      by: ['agentType'],
      where: { startedAt: { gte: since7d }, status: 'CRASHED' },
    }),
    db.session.groupBy({
      _max: { startedAt: true },
      by: ['agentType'],
    }),
  ]);

  const byAgent = (rows: { _count: { _all: number }; agentType: string }[]) =>
    new Map(rows.map((r) => [r.agentType, r._count._all]));

  const map7d = byAgent(counts7d);
  const map24h = byAgent(counts24h);
  const mapCrashes = byAgent(crashes7d);
  const mapLastSeen = new Map<string, Date | null>(
    lastSeenRows.map((r: { agentType: string; _max: { startedAt: Date | null } }) => [
      r.agentType,
      (r._max.startedAt as Date | null) ?? null,
    ]),
  );

  const buildRow = (agent: string) => {
    const sessions7d = map7d.get(agent) ?? 0;
    const sessions24h = map24h.get(agent) ?? 0;
    const crashCount = mapCrashes.get(agent) ?? 0;
    const lastSeen = mapLastSeen.get(agent) ?? null;
    const crashRate = sessions7d > 0 ? (crashCount / sessions7d) * 100 : null;
    const badge = statusBadge(lastSeen, sessions7d);
    return { agent, badge, crashRate, lastSeen, sessions24h, sessions7d };
  };

  const adapterRows = ADAPTER_AGENTS.map(buildRow);

  // Surface any agent types seen in data that are not in the known adapter list
  const allAgents = new Set([...map7d.keys(), ...mapLastSeen.keys()]);
  const otherRows = [...allAgents]
    .filter((a) => !(ADAPTER_AGENTS as readonly string[]).includes(a))
    .map(buildRow);

  const BADGE_STYLES = {
    active: 'bg-green-500/20 text-green-300',
    inactive: 'bg-white/10 text-white/30',
    stale: 'bg-yellow-500/20 text-yellow-300',
  };

  const allRows = [...adapterRows, ...otherRows];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Adapter health</h1>
        <p className="text-sm text-white/50">
          Session activity by agent type. An adapter is considered active if it sent a session in
          the last 48 hours.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5 text-left text-xs text-white/40">
              <th className="px-4 py-3 font-medium">Adapter</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last session</th>
              <th className="px-4 py-3 font-medium text-right">Sessions 24h</th>
              <th className="px-4 py-3 font-medium text-right">Sessions 7d</th>
              <th className="px-4 py-3 font-medium text-right">Crash rate 7d</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {allRows.map(({ agent, badge, crashRate, lastSeen, sessions24h, sessions7d }) => (
              <tr key={agent} className="hover:bg-white/5">
                <td className="px-4 py-3">
                  <span className="font-medium text-white/90">{agentDisplayName(agent)}</span>
                  <span className="ml-2 font-mono text-xs text-white/30">{agent}</span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[badge]}`}
                  >
                    {badge}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-white/50">{fmtRelative(lastSeen)}</td>
                <td className="px-4 py-3 text-right text-white/70">{sessions24h}</td>
                <td className="px-4 py-3 text-right text-white/70">{sessions7d}</td>
                <td className="px-4 py-3 text-right">
                  {crashRate == null ? (
                    <span className="text-white/20">—</span>
                  ) : (
                    <span className={crashRate > 5 ? 'text-red-400' : 'text-white/40'}>
                      {crashRate.toFixed(1)}%
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-white/30">
        Adapters ship events from developer machines via the hook CLI. This view reflects sessions
        received by the ingest service, not adapter binary availability.
      </p>
    </div>
  );
}
