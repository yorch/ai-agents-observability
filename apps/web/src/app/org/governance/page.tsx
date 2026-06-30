import { AuditAction } from '@ai-agents-observability/db';
import { OversightPanel } from '@/components/me/OversightPanel';
import { StatCard } from '@/components/team-org/StatCard';
import { getOrgOversight } from '@/lib/oversight-queries';
import { getAgentPrProvenance } from '@/lib/pr-provenance-queries';
import { getPrisma } from '@/lib/prisma';
import { requireOrgViewer } from '@/lib/roles';

export const dynamic = 'force-dynamic';

const DAYS_OPTS = [7, 30, 90] as const;
type Days = (typeof DAYS_OPTS)[number];

function parseDays(raw: string | undefined): Days {
  const n = Number(raw);
  return (DAYS_OPTS as readonly number[]).includes(n) ? (n as Days) : 30;
}

/**
 * Governance & oversight-posture report (R12). Aggregate, visibility-scoped
 * evidence of how much autonomy the org grants its coding agents and how
 * privileged access is governed — the kind of record EU AI Act Art. 14 / NIST
 * RMF / SOC 2 human-oversight expectations ask for. No individual is named.
 */
export default async function GovernancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireOrgViewer();
  const params = await searchParams;
  const days = parseDays(params.days);
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const db = getPrisma();
  const [oversight, transcriptViews, grantsApproved, activeGrants, pendingGrants, provenance] =
    await Promise.all([
      getOrgOversight(since),
      db.auditLog.count({ where: { action: AuditAction.VIEW_TRANSCRIPT, ts: { gte: since } } }),
      db.auditLog.count({ where: { action: AuditAction.GRANT_APPROVED, ts: { gte: since } } }),
      db.accessGrant.count({
        where: { expiresAt: { gt: now }, grantedAt: { not: null }, revokedAt: null },
      }),
      db.accessGrant.count({ where: { grantedAt: null, revokedAt: null } }),
      getAgentPrProvenance(since),
    ]);

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Governance &amp; oversight</h1>
          <p className="max-w-2xl text-sm text-white/50">
            Aggregate evidence of agent autonomy and privileged-access governance over the selected
            window. Oversight evidence for AI-coding governance (EU AI Act Art. 14 / NIST AI RMF /
            SOC 2) — aggregate only, no individual sessions or identities.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
          {DAYS_OPTS.map((d) => (
            <a
              key={d}
              href={`/org/governance?days=${d}`}
              className={`rounded-md px-3 py-1 text-xs font-mono ${
                d === days ? 'bg-brand-500 text-bg' : 'text-white/50 hover:text-white'
              }`}
            >
              {d}d
            </a>
          ))}
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-white/80">Autonomy posture</h2>
        {oversight.totalSessions === 0 ? (
          <p className="text-sm text-white/40">No sessions in this window.</p>
        ) : (
          <OversightPanel data={oversight} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-white/80">Privileged-access governance</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label="Active grants"
            value={activeGrants.toLocaleString()}
            sub="time-boxed, in effect"
          />
          <StatCard
            label="Pending grants"
            value={pendingGrants.toLocaleString()}
            sub="awaiting approval"
            warn={pendingGrants > 0}
          />
          <StatCard
            label="Grants approved"
            value={grantsApproved.toLocaleString()}
            sub={`in last ${days}d`}
          />
          <StatCard
            label="Transcript views"
            value={transcriptViews.toLocaleString()}
            sub={`audited · last ${days}d`}
          />
        </div>
        <p className="text-xs text-white/30">
          Every privileged transcript view is the owner or a time-boxed, approved grant — logged and
          visible to the viewed user.
        </p>
      </section>

      {/* R10: provenance + human review of AI-authored code. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-white/80">AI-authored code review</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Agent-assisted PRs" value={provenance.total.toLocaleString()} />
          <StatCard
            label="Awaiting review"
            value={provenance.awaitingReview.toLocaleString()}
            sub="open, no reviewer"
            warn={provenance.awaitingReview > 0}
          />
          <StatCard
            label="Merged w/o independent review"
            value={provenance.mergedWithoutIndependentReview.toLocaleString()}
            sub="reviewer = author / none"
            accent={provenance.mergedWithoutIndependentReview > 0 ? 'red' : 'green'}
          />
          <StatCard label="Window" value={`${days}d`} sub={`${provenance.rows.length} PRs shown`} />
        </div>
        {provenance.rows.length === 0 ? (
          <p className="text-sm text-white/40">No agent-assisted PRs in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-white/40">
                <th className="pb-2 font-medium">PR</th>
                <th className="pb-2 font-medium">Author</th>
                <th className="pb-2 font-medium">State</th>
                <th className="pb-2 font-medium">Independent review</th>
                <th className="pb-2 font-medium">Sessions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {provenance.rows.slice(0, 30).map((r) => (
                <tr key={`${r.repoOwner}/${r.repoName}#${r.prNumber}`}>
                  <td className="py-2">
                    <span className="text-white/40">
                      {r.repoOwner}/{r.repoName}
                    </span>{' '}
                    #{r.prNumber}
                    {r.reverted && <span className="ml-1 text-red-300">(reverted)</span>}
                  </td>
                  <td className="py-2 text-white/60">{r.authorLogin}</td>
                  <td className="py-2 text-white/60">{r.state}</td>
                  <td className="py-2">
                    {r.reviewedByOther ? (
                      <span className="text-emerald-400">✓ yes</span>
                    ) : r.awaitingReview ? (
                      <span className="text-yellow-300">awaiting</span>
                    ) : (
                      <span className="text-red-400">no</span>
                    )}
                  </td>
                  <td className="py-2 text-white/60">{r.sessionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-white/30">
          "Independent review" = at least one reviewer other than the PR author (SOC 2 CC8.1
          separation of duties). Agent assistance is inferred from linked telemetry sessions.
        </p>
      </section>
    </div>
  );
}
