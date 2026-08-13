import { AuditAction } from '@ai-agents-observability/db';
import { CheckIcon } from '@/components/icons';
import { OversightPanel } from '@/components/me/OversightPanel';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { Cell, Row, Stat, Table } from '@/components/ui';
import { getOrgOversight } from '@/lib/oversight-queries';
import { getAgentPrProvenance } from '@/lib/pr-provenance-queries';
import { getPrisma } from '@/lib/prisma';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * Governance & oversight-posture report (R12). Aggregate, visibility-scoped
 * evidence of how much autonomy the org grants its coding agents and how
 * privileged access is governed — the kind of record EU AI Act Art. 14 / NIST
 * RMF / SOC 2 human-oversight expectations ask for. No individual is named.
 */
export default async function GovernancePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();
  const { range: rangeParam } = await searchParams;
  // Shared ?range convention + DateRangePicker, consistent with team/org dashboards.
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const now = new Date();
  const since = daysAgo(range);

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
          <h1 className="font-display text-xl font-semibold tracking-tight text-text">
            Governance &amp; oversight
          </h1>
          <p className="max-w-2xl text-sm text-text-2">
            Aggregate evidence of agent autonomy and privileged-access governance over the selected
            window. Oversight evidence for AI-coding governance (EU AI Act Art. 14 / NIST AI RMF /
            SOC 2) — aggregate only, no individual sessions or identities.
          </p>
        </div>
        <DateRangePicker range={range} />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text">Autonomy posture</h2>
        {oversight.totalSessions === 0 ? (
          <p className="text-sm text-text-3">No sessions in this window.</p>
        ) : (
          <OversightPanel data={oversight} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text">Privileged-access governance</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Active grants"
            value={activeGrants.toLocaleString()}
            sub="time-boxed, in effect"
          />
          <Stat
            label="Pending grants"
            value={pendingGrants.toLocaleString()}
            sub="awaiting approval"
            accent={pendingGrants > 0 ? 'warn' : undefined}
          />
          <Stat
            label="Grants approved"
            value={grantsApproved.toLocaleString()}
            sub={`in last ${range}d`}
          />
          <Stat
            label="Transcript views"
            value={transcriptViews.toLocaleString()}
            sub={`audited · last ${range}d`}
          />
        </div>
        <p className="text-xs text-text-3">
          Every privileged transcript view is the owner or a time-boxed, approved grant — logged and
          visible to the viewed user.
        </p>
      </section>

      {/* R10: provenance + human review of AI-authored code. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text">AI-authored code review</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Agent-assisted PRs" value={provenance.total.toLocaleString()} />
          <Stat
            label="Awaiting review"
            value={provenance.awaitingReview.toLocaleString()}
            sub="open, no reviewer"
            accent={provenance.awaitingReview > 0 ? 'warn' : undefined}
          />
          <Stat
            label="Merged w/o independent review"
            value={provenance.mergedWithoutIndependentReview.toLocaleString()}
            sub="reviewer = author / none"
            accent={provenance.mergedWithoutIndependentReview > 0 ? 'crit' : 'good'}
          />
          <Stat
            label="Window"
            value={`${range}d`}
            sub={`${Math.min(provenance.rows.length, 30)} of ${provenance.total} PRs shown`}
          />
        </div>
        {provenance.rows.length === 0 ? (
          <p className="text-sm text-text-3">No agent-assisted PRs in this window.</p>
        ) : (
          <Table
            columns={[
              { label: 'PR' },
              { label: 'Author' },
              { label: 'State' },
              { label: 'Independent review' },
              { label: 'Sessions' },
            ]}
          >
            {provenance.rows.slice(0, 30).map((r) => (
              <Row key={`${r.repoOwner}/${r.repoName}#${r.prNumber}`}>
                <Cell>
                  <span className="text-text-3">
                    {r.repoOwner}/{r.repoName}
                  </span>{' '}
                  #{r.prNumber}
                  {r.reverted && <span className="ml-1 text-crit">(reverted)</span>}
                </Cell>
                <Cell className="text-text-2">{r.authorLogin}</Cell>
                <Cell className="text-text-2">{r.state}</Cell>
                <Cell>
                  {r.reviewedByOther ? (
                    <span className="inline-flex items-center gap-1 text-good">
                      <CheckIcon size={12} /> yes
                    </span>
                  ) : r.awaitingReview ? (
                    <span className="text-warn">awaiting</span>
                  ) : (
                    <span className="text-crit">no</span>
                  )}
                </Cell>
                <Cell className="text-text-2">{r.sessionCount}</Cell>
              </Row>
            ))}
          </Table>
        )}
        <p className="text-xs text-text-3">
          "Independent review" = at least one reviewer other than the PR author (SOC 2 CC8.1
          separation of duties). Agent assistance is inferred from linked telemetry sessions.
        </p>
      </section>
    </div>
  );
}
