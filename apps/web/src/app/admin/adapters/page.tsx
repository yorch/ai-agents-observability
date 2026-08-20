import { ADAPTER_AGENT_TYPES, agentDisplayName } from '@ai-agents-observability/schemas';
import { Badge, Card, CardEmpty, Cell, Row, Table } from '@/components/ui';
import { getAllRunsPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

export const dynamic = 'force-dynamic';

// Agents with a shipped capture adapter get a first-class row even at zero
// sessions (that an adapter is silent is the point of this page). Derived from the
// registry in packages/schemas — adding an agent there is the only edit needed.
const ADAPTER_AGENTS = ADAPTER_AGENT_TYPES;

function fmtRelative(date: Date | null): string {
  if (!date) {
    return 'never';
  }
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2) {
    return 'just now';
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) {
    return `${diffH}h ago`;
  }
  return `${Math.floor(diffH / 24)}d ago`;
}

function statusBadge(lastSeen: Date | null, sessions7d: number): 'active' | 'stale' | 'inactive' {
  if (!lastSeen || sessions7d === 0) {
    return 'inactive';
  }
  const ageMins = (Date.now() - lastSeen.getTime()) / 60_000;
  if (ageMins > 60 * 24 * 2) {
    return 'stale';
  }
  return 'active';
}

const BADGE_TONE = {
  active: 'good',
  inactive: 'neutral',
  stale: 'warn',
} as const;

export default async function AdaptersPage() {
  await requireOrgAdmin();

  // run-kind-exempt: adapter inventory is about the fleet, not about people —
  // "which agents are reporting at all" must count a CI runner's sessions too,
  // or a rollout that only runs in CI reads as an adapter that never shipped.
  const db = getAllRunsPrisma('adapter inventory counts every run, including CI');
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [counts7d, counts24h, crashes7d, lastSeenRows, versionRows] = await Promise.all([
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
    // Client version mix (last 30d): which CLI / agent versions are in the field.
    // COALESCE(agent_version, claude_code_version) — agent_version supersedes the
    // legacy per-session claude_code_version alias (DESIGN_DOC §5.2).
    db.$queryRaw<{ agent_type: string; session_count: bigint; version: string | null }[]>`
      SELECT agent_type,
             COALESCE(agent_version, claude_code_version) AS version,
             COUNT(*) AS session_count
      FROM sessions
      WHERE started_at >= ${since30d}
      GROUP BY agent_type, COALESCE(agent_version, claude_code_version)
      ORDER BY agent_type, session_count DESC
    `,
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
    return { agent, badge, crashRate, lastSeen, sessions7d, sessions24h };
  };

  const adapterRows = ADAPTER_AGENTS.map(buildRow);

  const allAgents = new Set([...map7d.keys(), ...mapLastSeen.keys()]);
  const otherRows = [...allAgents]
    .filter((a) => !(ADAPTER_AGENTS as readonly string[]).includes(a))
    .map(buildRow);

  const allRows = [...adapterRows, ...otherRows];

  // Group version rows by agent, each agent's versions ordered by session count.
  const versionsByAgent = new Map<string, { count: number; version: string }[]>();
  for (const r of versionRows) {
    const list = versionsByAgent.get(r.agent_type) ?? [];
    list.push({ count: Number(r.session_count), version: r.version ?? 'unknown' });
    versionsByAgent.set(r.agent_type, list);
  }
  const versionAgents = [...versionsByAgent.keys()].sort();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">
          Adapter health
        </h1>
        <p className="text-sm text-text-2">
          Session activity by agent type. An adapter is considered active if it sent a session in
          the last 48 hours.
        </p>
      </div>

      <Table
        columns={[
          { label: 'Adapter' },
          { label: 'Status' },
          { label: 'Last session' },
          { align: 'right', label: 'Sessions 24h' },
          { align: 'right', label: 'Sessions 7d' },
          { align: 'right', label: 'Crash rate 7d' },
        ]}
      >
        {allRows.map(({ agent, badge, crashRate, lastSeen, sessions24h, sessions7d }) => (
          <Row key={agent}>
            <Cell>
              <span className="font-medium text-text">{agentDisplayName(agent)}</span>
              <span className="ml-2 font-mono text-xs text-text-3">{agent}</span>
            </Cell>
            <Cell>
              <Badge tone={BADGE_TONE[badge]}>{badge}</Badge>
            </Cell>
            <Cell className="text-xs text-text-2">{fmtRelative(lastSeen)}</Cell>
            <Cell num className="text-text-2">
              {sessions24h}
            </Cell>
            <Cell num className="text-text-2">
              {sessions7d}
            </Cell>
            <Cell num>
              {crashRate == null ? (
                <span className="text-text-3">—</span>
              ) : (
                <span className={crashRate > 5 ? 'text-crit' : 'text-text-3'}>
                  {crashRate.toFixed(1)}%
                </span>
              )}
            </Cell>
          </Row>
        ))}
      </Table>

      <p className="text-xs text-text-3">
        Adapters ship events from developer machines via the hook CLI. This view reflects sessions
        received by the ingest service, not adapter binary availability.
      </p>

      <div className="space-y-3 pt-2">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold tracking-tight text-text">
            Client versions
          </h2>
          <p className="text-sm text-text-2">
            Version mix across sessions in the last 30 days — a lagging fleet on old CLI versions is
            a rollout signal.
          </p>
        </div>
        {versionAgents.length === 0 ? (
          <CardEmpty>No sessions in this period.</CardEmpty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {versionAgents.map((agent) => {
              const versions = versionsByAgent.get(agent) ?? [];
              const total = versions.reduce((s, v) => s + v.count, 0);
              return (
                <Card key={agent} contentClassName="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium text-text">{agentDisplayName(agent)}</span>
                    <span className="font-mono text-xs text-text-3">{total} sessions</span>
                  </div>
                  <div className="space-y-1.5">
                    {versions.slice(0, 6).map((v) => (
                      <div key={v.version} className="space-y-0.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono text-text-2">{v.version}</span>
                          <span className="text-text-3">
                            {v.count} · {total > 0 ? ((v.count / total) * 100).toFixed(0) : '0'}%
                          </span>
                        </div>
                        <div className="h-1 rounded-full bg-surface-2">
                          <div
                            className="h-full rounded-full bg-accent-muted"
                            style={{ width: `${total > 0 ? (v.count / total) * 100 : 0}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
