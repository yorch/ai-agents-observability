import { AuditAction } from '@ai-agents-observability/db';
import { PageHeader } from '@/components/team-org/PageHeader';
import { StatCard } from '@/components/team-org/StatCard';
import { getPrisma } from '@/lib/prisma';
import { requireOrgViewer } from '@/lib/roles';
import {
  type CategoryExposureRow,
  getCategoryExposure,
  getEgressServers,
  getLargeOutputEvents,
  getRepoExposure,
} from '@/lib/security-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

// Security & compliance posture (Tier 2). An aggregate, visibility-scoped view of
// the AI-agent data-flow surface the platform already captures: powerful tool
// categories and where they ran, external services reached via MCP, unusually
// large data movements, and the privileged-access audit trail. No individual
// developer's activity is exposed — every event query is scoped to org-metadata
// sharers, and drill-downs go through the standard audited session paths.

const CATEGORY_META: Record<string, { label: string; risk: 'high' | 'med' | 'low' }> = {
  exec: { label: 'Code execution', risk: 'high' },
  fs_read: { label: 'File reads', risk: 'low' },
  fs_write: { label: 'File writes', risk: 'med' },
  mcp: { label: 'MCP calls', risk: 'med' },
  other: { label: 'Other', risk: 'low' },
  search: { label: 'Search', risk: 'low' },
  task: { label: 'Subagent tasks', risk: 'low' },
  web: { label: 'Network / web', risk: 'high' },
};

function fmtBytes(n: number): string {
  if (n <= 0) {
    return '—';
  }
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1)}GB`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}MB`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}kB`;
  }
  return `${n}B`;
}

const RISK_STYLES: Record<string, string> = {
  high: 'bg-red-500/15 text-red-400',
  low: 'bg-surface-2 text-white/40',
  med: 'bg-yellow-500/15 text-yellow-400',
};

export default async function OrgSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);
  const db = getPrisma();

  const [categories, repoExposure, egress, largeOutputs, transcriptViews, sessionViews, exports] =
    await Promise.all([
      getCategoryExposure(since),
      getRepoExposure(since),
      getEgressServers(since),
      getLargeOutputEvents(since),
      db.auditLog.count({ where: { action: AuditAction.VIEW_TRANSCRIPT, ts: { gte: since } } }),
      db.auditLog.count({ where: { action: AuditAction.VIEW_SESSION, ts: { gte: since } } }),
      db.auditLog.count({
        where: {
          action: { in: [AuditAction.EXPORT_TEAM, AuditAction.EXPORT_ORG] },
          ts: { gte: since },
        },
      }),
    ]);

  const highRiskCalls = categories
    .filter((c) => CATEGORY_META[c.category]?.risk === 'high')
    .reduce((s, c) => s + c.totalCalls, 0);
  const totalEgressCalls = egress.reduce((s, e) => s + e.totalCalls, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`AI-agent data-flow & access posture · trailing ${range} days · aggregate, no individual content`}
        range={range}
        title="Security"
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="High-risk tool calls"
          value={highRiskCalls.toLocaleString()}
          sub="code execution + network"
          {...(highRiskCalls > 0 ? { accent: 'amber' as const } : {})}
        />
        <StatCard
          label="External services (MCP)"
          value={egress.length.toString()}
          sub={`${totalEgressCalls.toLocaleString()} egress calls`}
        />
        <StatCard
          label="Privileged views"
          value={(transcriptViews + sessionViews).toLocaleString()}
          sub={`${transcriptViews} transcript · ${sessionViews} session`}
        />
        <StatCard label="Data exports" value={exports.toLocaleString()} sub="team + org" />
      </div>

      {/* Tool-category exposure */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-white/70">Tool-category exposure</h2>
          <p className="mt-0.5 text-xs text-white/40">
            What kinds of powerful access the agents used, and how widely.
          </p>
        </div>
        {categories.length === 0 ? (
          <p className="text-sm text-white/40">No tool activity in this window.</p>
        ) : (
          <CategoryTable rows={categories} />
        )}
      </section>

      {/* Per-repo exposure */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-white/70">Exposure by repo</h2>
          <p className="mt-0.5 text-xs text-white/40">
            Repos ranked by code-execution and network egress — where a data-exposure review starts.
          </p>
        </div>
        {repoExposure.length === 0 ? (
          <p className="text-sm text-white/40">No exec/web/write activity in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Repo</th>
                <th className="pb-2 font-medium text-right">Exec</th>
                <th className="pb-2 font-medium text-right">Network</th>
                <th className="pb-2 font-medium text-right">Writes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {repoExposure.map((r) => (
                <tr key={r.repoName}>
                  <td className="py-2 font-mono text-xs text-white/80">{r.repoName}</td>
                  <td className="py-2 text-right font-mono text-red-300/80">
                    {r.execCalls.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-mono text-red-300/80">
                    {r.webCalls.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-mono text-white/60">
                    {r.writeCalls.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* External egress */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-white/70">External egress (MCP servers)</h2>
          <p className="mt-0.5 text-xs text-white/40">
            Each MCP server is an external service the agents reached — an egress inventory for
            security review.
          </p>
        </div>
        {egress.length === 0 ? (
          <p className="text-sm text-white/40">No MCP calls in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">Server</th>
                <th className="pb-2 font-medium text-right">Calls</th>
                <th className="pb-2 font-medium text-right">Users</th>
                <th className="pb-2 font-medium text-right">Repos</th>
                <th className="pb-2 font-medium text-right">Data out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {egress.map((e) => (
                <tr key={e.server}>
                  <td className="py-2 font-mono text-xs text-white/80">{e.server}</td>
                  <td className="py-2 text-right text-white/60">{e.totalCalls.toLocaleString()}</td>
                  <td className="py-2 text-right text-white/60">{e.distinctUsers}</td>
                  <td className="py-2 text-right text-white/60">{e.distinctRepos}</td>
                  <td className="py-2 text-right font-mono text-white/50">
                    {fmtBytes(e.totalOutputBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Large data movements */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-white/70">Largest data movements</h2>
          <p className="mt-0.5 text-xs text-white/40">
            Biggest single tool outputs on network / MCP / file-read — the rows to eyeball first.
            Sizes only; no content is stored.
          </p>
        </div>
        {largeOutputs.length === 0 ? (
          <p className="text-sm text-white/40">No sized tool outputs in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 font-medium">Tool</th>
                <th className="pb-2 font-medium">Repo</th>
                <th className="pb-2 font-medium text-right">Output</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {largeOutputs.map((r, i) => (
                <tr key={`${r.sessionId}-${i}`}>
                  <td className="py-2 text-xs text-white/50">
                    {r.ts.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}
                  </td>
                  <td className="py-2 text-xs">
                    <span className="font-mono text-white/80">{r.toolName ?? '—'}</span>
                    {r.category && <span className="ml-1.5 text-white/40">{r.category}</span>}
                  </td>
                  <td className="py-2 font-mono text-xs text-white/60">{r.repoName ?? '—'}</td>
                  <td className="py-2 text-right font-mono text-amber-300/80">
                    {fmtBytes(r.outputBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-white/30 text-center pt-2">
        Aggregate and visibility-scoped: only developers who share metadata with the org contribute,
        and no tool inputs/outputs are stored — the events firehose keeps hashes and byte sizes
        only. Transcript-level secret-class attribution is a follow-up (redaction classes are
        computed at ship time but not yet persisted).
      </p>
    </div>
  );
}

function CategoryTable({ rows }: { rows: CategoryExposureRow[] }) {
  const maxCalls = Math.max(...rows.map((r) => r.totalCalls), 1);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-white/40 text-left">
          <th className="pb-2 font-medium">Category</th>
          <th className="pb-2 font-medium">Risk</th>
          <th className="pb-2 font-medium">Volume</th>
          <th className="pb-2 font-medium text-right">Calls</th>
          <th className="pb-2 font-medium text-right">Users</th>
          <th className="pb-2 font-medium text-right">Repos</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/5">
        {rows.map((r) => {
          const meta = CATEGORY_META[r.category] ?? { label: r.category, risk: 'low' as const };
          return (
            <tr key={r.category}>
              <td className="py-2 text-white/80">{meta.label}</td>
              <td className="py-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${RISK_STYLES[meta.risk]}`}
                >
                  {meta.risk}
                </span>
              </td>
              <td className="py-2 pr-4 w-1/3">
                <div className="h-1.5 rounded-full bg-surface-2">
                  <div
                    className={`h-full rounded-full ${meta.risk === 'high' ? 'bg-red-400/60' : 'bg-accent/50'}`}
                    style={{ width: `${(r.totalCalls / maxCalls) * 100}%` }}
                  />
                </div>
              </td>
              <td className="py-2 text-right font-mono text-white/70">
                {r.totalCalls.toLocaleString()}
              </td>
              <td className="py-2 text-right text-white/60">{r.distinctUsers}</td>
              <td className="py-2 text-right text-white/60">{r.distinctRepos}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
